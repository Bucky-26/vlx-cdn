const express = require("express");
const cp = require("child_process");
const { getFfmpegPath } = require("../ffmpegHelper");
const { getMimeType } = require("../utils");
const { getTorrentData, prioritizeTorrentWindow, prepareTorrentOnServer, getSource, cleanStaleTorrents } = require("../torrentManager");

const router = express.Router();

router.get("/:infoHash", async (req, res) => {
    const infoHash = (req.params.infoHash || "").toLowerCase();
    let torrentData = getTorrentData(infoHash);

    if (!torrentData) {
        try {
            // Use the full cached source object (has magnet URL) for reliable peer discovery
            const cachedSource = getSource(infoHash);
            await prepareTorrentOnServer(cachedSource || infoHash);
            // Clean other stale torrents now that this one is active
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

    const { file, torrent } = torrentData;
    const fileOffset = file.offset || 0;
    const pieceLength = torrent && torrent.pieceLength ? torrent.pieceLength : 1048576;
    const totalPieces = torrent && torrent.pieces ? torrent.pieces.length : 1;

    // Transcode audio to stereo AAC with seeking support
    if (req.query.transcode === "audio" || req.query.transcode === "true" || req.query.transcode === "1") {
        const startTime = Math.max(0, parseFloat(req.query.t || req.query.start || req.query.ss || "0"));
        const port = process.env.PORT || 3000;

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
                prioritizeTorrentWindow(torrentData, targetPiece, 15, 80);
            }

            // Seek directly to keyframe via internal HTTP range stream with fastseek options
            ffmpegArgs = [
                "-loglevel", "warning",
                "-threads", "0",
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
                "-i", `http://127.0.0.1:${port}/stream/${infoHash}`,
                "-map", "0:v:0",
                "-map", "0:a:0?",
                "-sn",
                "-c:v", "copy",
                "-c:a", "aac",
                "-ac", "2",
                "-b:a", "192k",
                "-tune", "zerolatency",
                "-flush_packets", "1",
                "-frag_duration", "300000",
                "-max_muxing_queue_size", "4096",
                "-f", "mp4",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "pipe:1"
            ];
        } else {
            prioritizeTorrentWindow(torrentData, file._startPiece || 0, 15, 80);
            fileStream = file.createReadStream({ highWaterMark: 4 * 1024 * 1024 });
            ffmpegArgs = [
                "-loglevel", "warning",
                "-threads", "0",
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
                "-tune", "zerolatency",
                "-flush_packets", "1",
                "-frag_duration", "300000",
                "-max_muxing_queue_size", "4096",
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

    // Direct Stream with HTTP Range Seeking
    const range = req.headers.range;

    if (!range) {
        res.writeHead(200, {
            "Content-Length": file.length,
            "Content-Type": getMimeType(file.name),
            "Accept-Ranges": "bytes"
        });

        prioritizeTorrentWindow(torrentData, file._startPiece || 0, 15, 80);
        const stream = file.createReadStream({ highWaterMark: 4 * 1024 * 1024 });

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

    // Determine target piece and immediately prioritize rush + forward window
    const targetPiece = Math.max(0, Math.min(
        totalPieces - 1,
        Math.floor((fileOffset + start) / pieceLength)
    ));
    prioritizeTorrentWindow(torrentData, targetPiece, 15, 80);

    const chunkSize = end - start + 1;

    res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${file.length}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": getMimeType(file.name)
    });

    const stream = file.createReadStream({ start, end, highWaterMark: 4 * 1024 * 1024 });
    let currentByteOffset = start;
    let lastPushedPiece = targetPiece;

    // Dynamically advance forward buffer window as stream data flows
    stream.on("data", (chunk) => {
        currentByteOffset += chunk.length;
        const currentPiece = Math.floor((fileOffset + currentByteOffset) / pieceLength);
        if (currentPiece - lastPushedPiece >= 4) {
            lastPushedPiece = currentPiece;
            prioritizeTorrentWindow(torrentData, currentPiece, 12, 80);
        }
    });

    stream.on("error", (err) => {
        if (err.code !== "PREMATURE_CLOSE" && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
            console.error("Stream error:", err.message);
        }
    });

    res.on("close", () => {
        stream.destroy();
    });

    stream.pipe(res);
});

module.exports = router;
