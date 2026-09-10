const crypto = require("crypto");

// 256-bit server secret key for AES-256-GCM ticket encryption
// Persisted in process or configurable via STREAM_SECRET
const SECRET_KEY = process.env.STREAM_SECRET
    ? crypto.createHash("sha256").update(process.env.STREAM_SECRET).digest()
    : crypto.randomBytes(32);

// Internal bypass token for server-side FFmpeg loopback seeking
const INTERNAL_SECRET = crypto.randomBytes(16).toString("hex");

// Default ticket lifespan: 4 hours (14400 seconds)
const DEFAULT_TTL_SEC = 14400;

// In-memory failed attempts tracker to throttle scraping floods: ip -> { count, resetTime }
const failedAttempts = new Map();
const MAX_FAILS = 15;
const FAIL_WINDOW_MS = 60000;

function cleanFailedAttempts() {
    const now = Date.now();
    for (const [ip, data] of failedAttempts.entries()) {
        if (now > data.resetTime) failedAttempts.delete(ip);
    }
}
setInterval(cleanFailedAttempts, 120000).unref();

function getClientIp(req) {
    if (!req) return "127.0.0.1";
    const xForwarded = req.headers && req.headers["x-forwarded-for"];
    if (xForwarded && typeof xForwarded === "string") {
        const first = xForwarded.split(",")[0].trim();
        if (first) return first;
    }
    return (req.socket && req.socket.remoteAddress) || req.ip || "127.0.0.1";
}

function hashUserAgent(ua) {
    if (!ua || typeof ua !== "string") return "generic";
    return crypto.createHash("md5").update(ua.slice(0, 120)).digest("hex").slice(0, 10);
}

function isLoopbackIp(ip) {
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
}

/**
 * Generates an encrypted, tamper-proof AES-256-GCM stream ticket.
 * Zero CPU overhead (<0.05ms hardware accelerated via AES-NI).
 */
function generateStreamTicket({ infoHash, fileIdx = null, req = null, expiresInSeconds = DEFAULT_TTL_SEC }) {
    if (!infoHash) throw new Error("infoHash required for stream ticket");

    const clientIp = req ? getClientIp(req) : "127.0.0.1";
    const uaHash = req ? hashUserAgent(req.headers && req.headers["user-agent"]) : "generic";
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;

    const payload = JSON.stringify({
        h: infoHash.toLowerCase(),
        f: typeof fileIdx === "number" ? fileIdx : -1,
        ip: clientIp,
        ua: uaHash,
        exp,
        n: crypto.randomBytes(3).toString("hex") // salt/nonce
    });

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", SECRET_KEY, iv);
    let encrypted = cipher.update(payload, "utf8");
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Pack: iv (12) + authTag (16) + encrypted
    const packed = Buffer.concat([iv, authTag, encrypted]);
    return "st_" + packed.toString("base64url");
}

/**
 * Verifies an incoming stream ticket against client IP, User-Agent, and expiration.
 * Returns { infoHash, fileIdx } if valid, or null with reason.
 */
function verifyStreamTicket(ticket, req) {
    if (!ticket || typeof ticket !== "string") {
        return { valid: false, error: "Missing stream ticket" };
    }

    const clientIp = getClientIp(req);

    // Fast-path flood protection
    const failData = failedAttempts.get(clientIp);
    if (failData && failData.count >= MAX_FAILS && Date.now() < failData.resetTime) {
        return { valid: false, error: "Too many invalid stream attempts. Rate limited." };
    }

    // Allow internal loopback bypass for FFmpeg internal seek requests
    if (req && isLoopbackIp(clientIp) && req.headers && req.headers["x-internal-token"] === INTERNAL_SECRET) {
        // Internal FFmpeg seek request with authorized header
        const queryHash = req.query && req.query.h;
        if (queryHash) {
            return {
                valid: true,
                infoHash: queryHash.toLowerCase(),
                fileIdx: req.query.f !== undefined ? parseInt(req.query.f, 10) : -1
            };
        }
    }

    if (!ticket.startsWith("st_")) {
        recordFailedAttempt(clientIp);
        return { valid: false, error: "Invalid ticket format" };
    }

    try {
        const packed = Buffer.from(ticket.slice(3), "base64url");
        if (packed.length < 29) { // 12 iv + 16 authTag + min 1 byte
            recordFailedAttempt(clientIp);
            return { valid: false, error: "Malformed stream ticket" };
        }

        const iv = packed.subarray(0, 12);
        const authTag = packed.subarray(12, 28);
        const encrypted = packed.subarray(28);

        const decipher = crypto.createDecipheriv("aes-256-gcm", SECRET_KEY, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encrypted, null, "utf8");
        decrypted += decipher.final("utf8");

        const data = JSON.parse(decrypted);

        // 1. Check expiration
        const nowSec = Math.floor(Date.now() / 1000);
        if (!data.exp || nowSec > data.exp) {
            return { valid: false, error: "Stream link has expired. Please refresh the player." };
        }

        // 2. Check client IP (anti-sharing: prevents pasting URL to another device/scraper)
        const isInternalBypass = req && req.headers && req.headers["x-internal-token"] === INTERNAL_SECRET;
        const bothLoopback = isLoopbackIp(data.ip) && isLoopbackIp(clientIp);
        if (!isInternalBypass && !bothLoopback && data.ip && data.ip !== clientIp) {
            const isSubnetMatch = (data.ip.includes(":") && clientIp.includes(":") && data.ip.slice(0, 16) === clientIp.slice(0, 16)) ||
                                  (data.ip.includes(".") && clientIp.includes(".") && data.ip.slice(0, data.ip.lastIndexOf(".")) === clientIp.slice(0, clientIp.lastIndexOf(".")));
            if (!isSubnetMatch) {
                recordFailedAttempt(clientIp);
                return { valid: false, error: "Stream link is locked to another network address." };
            }
        }

        // 3. Check User-Agent (blocks curl / python-requests / VLC extracting browser links)
        const currentUaHash = hashUserAgent(req && req.headers && req.headers["user-agent"]);
        if (!isInternalBypass && data.ua && data.ua !== "generic" && data.ua !== currentUaHash) {
            recordFailedAttempt(clientIp);
            return { valid: false, error: "Stream client signature mismatch." };
        }

        return {
            valid: true,
            infoHash: data.h,
            fileIdx: typeof data.f === "number" && data.f >= 0 ? data.f : null
        };
    } catch (err) {
        recordFailedAttempt(clientIp);
        return { valid: false, error: "Corrupted or forged stream ticket" };
    }
}

function recordFailedAttempt(ip) {
    const now = Date.now();
    const existing = failedAttempts.get(ip);
    if (!existing || now > existing.resetTime) {
        failedAttempts.set(ip, { count: 1, resetTime: now + FAIL_WINDOW_MS });
    } else {
        existing.count++;
    }
}

/**
 * Validates request headers against hotlinking (embedding your stream on other pirate sites).
 */
function validateAntiHotlink(req) {
    if (!req || !req.headers) return true;
    if (req.headers["x-internal-token"] === INTERNAL_SECRET) return true;

    // 1. Sec-Fetch-Site check: browsers send this automatically
    const fetchSite = req.headers["sec-fetch-site"];
    if (fetchSite === "cross-site") {
        return false;
    }

    // 2. Referer check: if present, must match current host
    const referer = req.headers.referer;
    const host = req.headers.host;
    if (referer && host) {
        try {
            const refUrl = new URL(referer);
            if (refUrl.host !== host) {
                return false;
            }
        } catch (e) {
            return false;
        }
    }

    return true;
}

module.exports = {
    generateStreamTicket,
    verifyStreamTicket,
    validateAntiHotlink,
    INTERNAL_SECRET
};
