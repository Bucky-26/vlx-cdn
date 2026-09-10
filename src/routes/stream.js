const express = require("express");
const cp = require("child_process");
const { getFfmpegPath } = require("../ffmpegHelper");
const { getMimeType } = require("../utils");
const {
    getTorrentData,
    prioritizeTorrentWindow,
    prepareTorrentOnServer,
    getSource,
    cleanStaleTorrents
} = require("../torrentManager");
const {
    verifyStreamTicket,
    validateAntiHotlink,
    INTERNAL_SECRET
} = require("../services/streamSecurity");

const router = express.Router();

/**
 * Shared media streaming pipeline (Direct HTTP Range or Low-CPU Audio Transcoding).
 */
async function handleStreamPlayback(req, res, infoHash, targetFileIdx = null, ticketStr = "") {
    infoHash = (infoHash || "").toLowerCase();
    let torrentData = getTorrentData(infoHash);

    if (!torrentData) {
        try {
            const cachedSource = getSource(infoHash);
            await prepareTorrentOnServer(cachedSource || infoHash, 0, { fileIdx: targetFileIdx, req });
            cleanStaleTorrents(infoHash);
            torrentData = getTorrentData(infoHash);
        } catch (err) {
            console.error("Stream on-demand preparation error:", err.message);
            return res.status(503).send("Stream not ready: " + err.message);
        }
    }

    if (!torrentData) {
        return res.status(404).send("Stream not found");
    }

    // Resolve target file: prefer exact targetFileIdx if specified
    let file = torrentData.file;
    if (typeof targetFileIdx === "number" && targetFileIdx >= 0) {
        if (torrentData.torrent && torrentData.torrent.files && torrentData.torrent.files[targetFileIdx]) {
            file = torrentData.torrent.files[targetFileIdx];
        }
    } else if (req.query.fileIdx !== undefined) {
        const idx = parseInt(req.query.fileIdx, 10);
        if (!isNaN(idx) && torrentData.torrent && torrentData.torrent.files && torrentData.torrent.files[idx]) {
            file = torrentData.torrent.files[idx];
        }
    }

    const { torrent } = torrentData;
    const fileOffset = file.offset || 0;
    const pieceLength = torrent && torrent.pieceLength ? torrent.pieceLength : 1048576;
    const totalPieces = torrent && torrent.pieces ? torrent.pieces.length : 1;

    // ── Transcode Audio to AAC (Low-CPU Mode: -threads 2, ultrafast preset) ──
    if (req.query.transcode === "audio" || req.query.transcode === "true" || req.query.transcode === "1") {
        const startTime = Math.max(0, parseFloat(req.query.t || req.query.start || req.query.ss || "0"));
        const port = process.env.PORT || 3000;
        const resolvedIdx = torrent && torrent.files ? torrent.files.indexOf(file) : -1;

        res.writeHead(200, {
            "Content-Type": "video/mp4",
            "Accept-Ranges": "none",
            "X-Stream-Start-Time": String(startTime),
            "Cache-Control": "no-cache, no-store, must-revalidate"
        });

        let fileStream = null;
        let ffmpegArgs = [];

        if (startTime > 0) {
            // Prioritize swarm pieces at target seek position before spawning FFmpeg
            if (torrentData.duration > 0) {
                const approxByte = Math.floor((startTime / torrentData.duration) * file.length);
                const targetPiece = Math.max(0, Math.min(
                    totalPieces - 1,
                    Math.floor((fileOffset + approxByte) / pieceLength)
                ));
                prioritizeTorrentWindow(torrentData, targetPiece, 15, 60);
            }

            // Internal authenticated loopback seek: low CPU (-threads 2, -preset ultrafast)
            ffmpegArgs = [
                "-loglevel", "warning",
                "-threads", "2",
                "-headers", `X-Internal-Token: ${INTERNAL_SECRET}\r\n`,
                "-seekable", "1",
                "-reconnect", "1",
                "-reconnect_streamed", "1",
                "-reconnect_delay_max", "2",
                "-analyzeduration", "1000000",
                "-probesize", "1000000",
                "-fflags", "+fastseek+nobuffer",
                "-flags", "+low_delay",
                "-noaccurate_seek",
                "-ss", String(startTime),
                "-i", `http://127.0.0.1:${port}/stream/internal?h=${infoHash}&f=${resolvedIdx}`,
                "-map", "0:v:0",
                "-map", "0:a:0?",
                "-sn",
                "-c:v", "copy",
                "-c:a", "aac",
                "-ac", "2",
                "-b:a", "192k",
                "-preset", "ultrafast",
                "-tune", "zerolatency",
                "-flush_packets", "1",
                "-frag_duration", "300000",
                "-max_muxing_queue_size", "2048",
                "-f", "mp4",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "pipe:1"
            ];
        } else {
            prioritizeTorrentWindow(torrentData, file._startPiece || 0, 15, 60);
            fileStream = file.createReadStream({ highWaterMark: 2 * 1024 * 1024 }); // 2MB chunk buffer for low RAM
            ffmpegArgs = [
                "-loglevel", "warning",
                "-threads", "2",
                "-analyzeduration", "1000000",
                "-probesize", "1000000",
                "-fflags", "+fastseek+nobuffer",
                "-flags", "+low_delay",
                "-i", "pipe:0",
                "-map", "0:v:0",
                "-map", "0:a:0?",
                "-sn",
                "-c:v", "copy",
                "-c:a", "aac",
                "-ac", "2",
                "-b:a", "192k",
                "-preset", "ultrafast",
                "-tune", "zerolatency",
                "-flush_packets", "1",
                "-frag_duration", "300000",
                "-max_muxing_queue_size", "2048",
                "-f", "mp4",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "pipe:1"
            ];
        }

        const ffmpegBin = getFfmpegPath();
        const proc = cp.spawn(ffmpegBin, ffmpegArgs);
        if (fileStream) {
            fileStream.pipe(proc.stdin);
        }
        proc.stdout.pipe(res);

        let isCleanedUp = false;
        const cleanup = () => {
            if (isCleanedUp) return;
            isCleanedUp = true;
            if (fileStream) {
                try { fileStream.destroy(); } catch (e) {}
            }
            try { proc.kill("SIGKILL"); } catch (e) {}
        };

        if (fileStream) {
            fileStream.on("error", (err) => {
                if (err.code !== "PREMATURE_CLOSE" && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
                    console.error("File stream transcode error:", err.message);
                }
                cleanup();
            });
        }

        proc.on("error", (err) => {
            console.error("FFmpeg spawn error:", err.message);
            cleanup();
            if (!res.headersSent) {
                res.status(500).send("Transcoding error: " + err.message);
            } else {
                try { res.end(); } catch (e) {}
            }
        });

        proc.stdin && proc.stdin.on("error", () => {});
        proc.stdout && proc.stdout.on("error", () => {});
        proc.stderr && proc.stderr.on("data", (data) => {
            const str = data.toString().trim();
            if (str && !str.includes("invalid as first byte") && !str.includes("Seek to desired resync point failed")) {
                console.error("FFmpeg:", str);
            }
        });

        res.on("close", cleanup);
        return;
    }

    // ── Direct Video Streaming with HTTP 206 Partial Content Seeking ─────────
    const range = req.headers.range;

    if (!range) {
        res.writeHead(200, {
            "Content-Length": file.length,
            "Content-Type": getMimeType(file.name),
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache, no-store, must-revalidate"
        });

        prioritizeTorrentWindow(torrentData, file._startPiece || 0, 15, 60);
        const stream = file.createReadStream({ highWaterMark: 2 * 1024 * 1024 });

        stream.on("error", (err) => {
            if (err.code !== "PREMATURE_CLOSE" && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
                console.error("Stream error:", err.message);
            }
        });

        res.on("close", () => {
            stream.destroy();
        });

        return stream.pipe(res);
    }

    const parts = range.replace(/bytes=/, "").split("-");
    let start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;

    if (isNaN(start)) {
        start = file.length - end;
        end = file.length - 1;
    }

    if (isNaN(end) || start > end || start >= file.length || start < 0) {
        res.writeHead(416, {
            "Content-Range": `bytes */${file.length}`
        });
        return res.end();
    }

    if (end >= file.length) {
        end = file.length - 1;
    }

    // Target piece prioritizing with low memory footprint (10 rush, 25 forward)
    const targetPiece = Math.max(0, Math.min(
        totalPieces - 1,
        Math.floor((fileOffset + start) / pieceLength)
    ));
    prioritizeTorrentWindow(torrentData, targetPiece, 15, 60);

    const chunkSize = end - start + 1;
    res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${file.length}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": getMimeType(file.name),
        "Cache-Control": "no-cache, no-store, must-revalidate"
    });

    const stream = file.createReadStream({ start, end, highWaterMark: 2 * 1024 * 1024 });

    stream.on("error", (err) => {
        if (err.code !== "PREMATURE_CLOSE" && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
            console.error("Stream range error:", err.message);
        }
    });

    res.on("close", () => {
        stream.destroy();
    });

    stream.pipe(res);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURE PROTECTED STREAM ENDPOINT: /stream/play/:ticket
// Validates anti-hotlinking headers, client IP binding, User-Agent, and expiration.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/play/:ticket", (req, res) => {
    // 1. Anti-Hotlinking check (rejects cross-site embeds and external referers)
    if (!validateAntiHotlink(req)) {
        return res.status(403).json({
            error: "Forbidden",
            message: "Direct hotlinking or unauthorized cross-site embed is prohibited."
        });
    }

    // 2. Cryptographic ticket verification
    const verified = verifyStreamTicket(req.params.ticket, req);
    if (!verified.valid) {
        return res.status(403).json({
            error: "Forbidden",
            message: verified.error || "Invalid or expired stream authorization."
        });
    }

    return handleStreamPlayback(req, res, verified.infoHash, verified.fileIdx, req.params.ticket);
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL LOOPBACK ENDPOINT: /stream/internal
// Reserved exclusively for internal FFmpeg seeking.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/internal", (req, res) => {
    const isLoopback = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
    const internalToken = req.headers["x-internal-token"];

    if (!isLoopback || internalToken !== INTERNAL_SECRET) {
        return res.status(403).send("Forbidden: Internal endpoint.");
    }

    const infoHash = req.query.h;
    const fileIdx = req.query.f !== undefined ? parseInt(req.query.f, 10) : null;
    if (!infoHash) return res.status(400).send("Missing hash");

    return handleStreamPlayback(req, res, infoHash, fileIdx, "");
});

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY / DIRECT INFOHASH ENDPOINT: /stream/:infoHash
// Direct external access to raw torrent hashes without a ticket is blocked.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:infoHash", (req, res) => {
    // If ticket is provided in query (?ticket=st_...), allow verification
    const ticket = req.query.ticket;
    if (ticket) {
        if (!validateAntiHotlink(req)) {
            return res.status(403).send("Forbidden: Hotlinking prohibited.");
        }
        const verified = verifyStreamTicket(ticket, req);
        if (verified.valid) {
            return handleStreamPlayback(req, res, verified.infoHash, verified.fileIdx, ticket);
        }
    }

    // Block raw scraping / direct access to torrent hash
    return res.status(403).json({
        error: "Forbidden",
        message: "Direct infoHash streaming is disabled. Access must use a protected stream ticket."
    });
});

module.exports = router;
