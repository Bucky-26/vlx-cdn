const express = require("express");
const os = require("os");
const { getClient, getTorrentData, destroyTorrent, cleanIdleTorrents } = require("../torrentManager");
const supabaseService = require("../services/supabaseService");

const router = express.Router();

// Enforce admin key or Supabase JWT check middleware
async function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const adminKey = req.headers["x-admin-key"] || bearerToken || req.query.adminKey;
    const expectedKey = process.env.ADMIN_SECRET_KEY || "admin123";

    if (!adminKey) {
        return res.status(401).json({ success: false, error: "Unauthorized: Missing authentication credentials" });
    }

    // 1. Check if token is master secret key
    if (adminKey === expectedKey) {
        req.adminUser = { email: "root-admin@viewlix.site", role: "superadmin" };
        return next();
    }

    // 2. Check if token is a valid Supabase Auth JWT
    if (supabaseService.isConfigured()) {
        const user = await supabaseService.verifyUserToken(adminKey);
        if (user) {
            req.adminUser = user;
            return next();
        }
    }

    return res.status(401).json({ success: false, error: "Unauthorized: Invalid or expired session token" });
}

/**
 * POST /api/admin/login
 * Validates credentials via Supabase Auth (with master secret key fallback)
 */
router.post("/login", async (req, res) => {
    const { email, password } = req.body || {};
    const expectedKey = process.env.ADMIN_SECRET_KEY || "admin123";

    if (!password) {
        return res.status(400).json({ success: false, error: "Password is required" });
    }

    // Direct master secret key pass-through
    if (!email && password === expectedKey) {
        return res.json({
            success: true,
            token: expectedKey,
            user: { email: "root-admin@viewlix.site", role: "superadmin" },
            message: "Root admin key authenticated"
        });
    }

    // Supabase Auth Email + Password
    if (supabaseService.isConfigured() && email) {
        try {
            const authData = await supabaseService.signInAdmin(email, password);
            return res.json({
                success: true,
                token: authData.session.access_token,
                user: authData.user,
                message: "Supabase authenticated successfully"
            });
        } catch (err) {
            // Fallback: Check if master password was entered in password field
            if (password === expectedKey) {
                return res.json({
                    success: true,
                    token: expectedKey,
                    user: { email, role: "superadmin" },
                    message: "Root override authenticated"
                });
            }

            return res.status(401).json({ success: false, error: err.message || "Invalid email or password" });
        }
    }

    // Fallback password check when Supabase is offline
    if (password === expectedKey) {
        return res.json({
            success: true,
            token: expectedKey,
            user: { email: email || "root-admin@viewlix.site" },
            message: "Admin authenticated successfully"
        });
    }

    return res.status(401).json({ success: false, error: "Invalid admin passcode or email" });
});

/**
 * POST /api/admin/register (Disabled)
 */
router.post("/register", (req, res) => {
    return res.status(403).json({
        success: false,
        error: "Registration is disabled. Admin accounts must be created directly in the Supabase Dashboard."
    });
});

/**
 * GET /api/admin/verify
 * Validates current session token
 */
router.get("/verify", requireAdmin, (req, res) => {
    return res.json({ success: true, verified: true, user: req.adminUser });
});

/**
 * GET /api/admin/status
 * Returns system health, active WebTorrent swarms, reader counts, and Supabase status
 */
router.get("/status", requireAdmin, (req, res) => {
    const client = getClient();
    const now = Date.now();
    const activeTorrents = client && client.torrents ? client.torrents.map((t) => {
        const hash = (t.infoHash || "").toLowerCase();
        const data = getTorrentData(hash);
        const readers = (data && data.activeReaders) || 0;
        const lastAccess = (data && data.lastAccessed) || 0;
        const idleSec = readers === 0 && lastAccess > 0 ? Math.round((now - lastAccess) / 1000) : 0;
        return {
            name: t.name,
            infoHash: t.infoHash,
            progress: Math.round(t.progress * 100),
            downloadSpeedKb: Math.round(t.downloadSpeed / 1024),
            uploadSpeedKb: Math.round(t.uploadSpeed / 1024),
            numPeers: t.numPeers,
            downloadedMb: Math.round(t.downloaded / (1024 * 1024)),
            totalMb: Math.round(t.length / (1024 * 1024)),
            timeRemainingSec: t.timeRemaining ? Math.round(t.timeRemaining / 1000) : null,
            activeReaders: readers,
            idleSeconds: idleSec,
            isIdle: readers === 0
        };
    }) : [];

    const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
    const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
    const processMemMb = Math.round(process.memoryUsage().rss / (1024 * 1024));

    return res.json({
        success: true,
        uptimeSeconds: Math.round(process.uptime()),
        supabaseConfigured: supabaseService.isConfigured(),
        system: {
            platform: os.platform(),
            cpuCount: os.cpus().length,
            processMemoryMb: processMemMb,
            freeMemoryMb: freeMemMb,
            totalMemoryMb: totalMemMb
        },
        torrentClient: {
            initialized: Boolean(client),
            activeSwarmCount: activeTorrents.length,
            downloadSpeedKb: activeTorrents.reduce((acc, t) => acc + t.downloadSpeedKb, 0),
            uploadSpeedKb: activeTorrents.reduce((acc, t) => acc + t.uploadSpeedKb, 0),
            torrents: activeTorrents
        }
    });
});

/**
 * POST /api/admin/torrents/remove
 * Forcibly removes a specific torrent from memory and storage
 */
router.post("/torrents/remove", requireAdmin, (req, res) => {
    const { infoHash } = req.body;
    if (!infoHash) {
        return res.status(400).json({ error: "infoHash is required" });
    }
    const removed = destroyTorrent(infoHash, true);
    return res.json({ success: true, removed, infoHash });
});

/**
 * POST /api/admin/torrents/purge-idle
 * Immediately purges all swarms with 0 active readers
 */
router.post("/torrents/purge-idle", requireAdmin, (req, res) => {
    cleanIdleTorrents(0);
    return res.json({ success: true, message: "All idle torrents purged." });
});

/**
 * GET /api/admin/sources/:tmdbId
 * Fetch custom magnet sources for a media item
 */
router.get("/sources/:tmdbId", requireAdmin, async (req, res) => {
    const { tmdbId } = req.params;
    const { mediaType = "movie", season, episode } = req.query;

    const sources = await supabaseService.getPinnedSources(tmdbId, mediaType, season, episode);
    return res.json({
        success: true,
        tmdbId,
        mediaType,
        sources
    });
});

/**
 * POST /api/admin/sources
 * Add or override a media source in Supabase
 */
router.post("/sources", requireAdmin, async (req, res) => {
    const { tmdbId, mediaType, season, episode, title, magnetUrl, infoHash, quality, fileIdx, priority } = req.body;

    if (!tmdbId || (!magnetUrl && !infoHash)) {
        return res.status(400).json({ error: "tmdbId and either magnetUrl or infoHash are required" });
    }

    // Extract infoHash from magnet link if missing
    let resolvedHash = infoHash;
    if (!resolvedHash && magnetUrl) {
        const match = magnetUrl.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
        if (match) resolvedHash = match[1];
    }

    if (!resolvedHash) {
        return res.status(400).json({ error: "Could not resolve infoHash from magnet URL" });
    }

    const result = await supabaseService.addMediaSource({
        tmdbId,
        mediaType: mediaType || "movie",
        season,
        episode,
        title,
        magnetUrl: magnetUrl || `magnet:?xt=urn:btih:${resolvedHash}`,
        infoHash: resolvedHash,
        quality: quality || "1080p",
        fileIdx,
        priority: priority || 10
    });

    if (!result.success) {
        return res.status(500).json({ error: result.error });
    }

    return res.json({ success: true, data: result.data });
});

/**
 * DELETE /api/admin/sources/:id
 * Delete a media source by ID
 */
router.delete("/sources/:id", requireAdmin, async (req, res) => {
    const { id } = req.params;
    const result = await supabaseService.deleteMediaSource(id);
    if (!result.success) {
        return res.status(500).json({ error: result.error });
    }
    return res.json({ success: true });
});

/**
 * GET /api/admin/history
 * Fetch recent user watch activity
 */
router.get("/history", requireAdmin, async (req, res) => {
    const history = await supabaseService.getWatchHistory();
    return res.json({ success: true, history });
});

/**
 * POST /api/admin/parse-magnet
 * Utility to parse a magnet link and extract infoHash, displayName, trackers
 */
router.post("/parse-magnet", requireAdmin, (req, res) => {
    const { magnetUrl } = req.body;
    if (!magnetUrl || !magnetUrl.startsWith("magnet:?")) {
        return res.status(400).json({ error: "Invalid magnet URL" });
    }

    const hashMatch = magnetUrl.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
    const dnMatch = magnetUrl.match(/dn=([^&]+)/i);

    return res.json({
        success: true,
        infoHash: hashMatch ? hashMatch[1].toLowerCase() : null,
        displayName: dnMatch ? decodeURIComponent(dnMatch[1].replace(/\+/g, " ")) : null
    });
});

module.exports = router;
