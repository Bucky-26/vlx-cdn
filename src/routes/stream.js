const express = require("express");
const cp = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { getMimeType } = require("../utils");
const { getTorrentData } = require("../torrentManager");

const router = express.Router();

router.get("/:infoHash", (req, res) => {
    const infoHash = (req.params.infoHash || "").toLowerCase();
    const torrentData = getTorrentData(infoHash);

    if (!torrentData) {
        return res.status(404).send("Torrent not found");
    }

    const { file } = torrentData;

    // Transcode audio to stereo AAC with seeking support
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
            // Pre-prioritize pieces at target seek position before spawning FFmpeg
            try {
                if (torrentData.duration > 0 && torrentData.torrent && torrentData.torrent.pieceLength && torrentData.torrent.pieces) {
                    const approxByte = Math.floor((startTime / torrentData.duration) * file.length);
                    const targetPiece = Math.max(0, Math.min(
                        torrentData.torrent.pieces.length - 1,
                        Math.floor(((file.offset || 0) + approxByte) / torrentData.torrent.pieceLength)
                    ));
                    const rushEnd = Math.min(torrentData.torrent.pieces.length - 1, targetPiece + 8);
                    if (torrentData.torrent.critical && targetPiece <= rushEnd) {
                        torrentData.torrent.critical(targetPiece, rushEnd);
                    }
                }
            } catch (err) {}

            // Seek directly to keyframe via internal HTTP range stream with fastseek options
            ffmpegArgs = [
                "-loglevel", "warning",
                "-analyzeduration", "1500000",
                "-probesize", "1500000",
                "-fflags", "+fastseek+nobuffer",
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
                "-max_muxing_queue_size", "4096",
                "-f", "mp4",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "pipe:1"
            ];
        } else {
            fileStream = file.createReadStream();
            ffmpegArgs = [
                "-loglevel", "warning",
                "-i", "pipe:0",
                "-map", "0:v:0",
                "-map", "0:a:0?",
                "-sn",
                "-c:v", "copy",
                "-c:a", "aac",
                "-ac", "2",
                "-b:a", "192k",
                "-max_muxing_queue_size", "4096",
                "-f", "mp4",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "pipe:1"
            ];
        }

        const proc = cp.spawn(ffmpegPath, ffmpegArgs);
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

        const stream = file.createReadStream();

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

    // Safely prioritize swarm pieces for this seek position
    try {
        if (torrentData.torrent && torrentData.torrent.pieceLength && torrentData.torrent.pieces) {
            const fileOffset = file.offset || 0;
            const targetPiece = Math.max(0, Math.min(
                torrentData.torrent.pieces.length - 1,
                Math.floor((fileOffset + start) / torrentData.torrent.pieceLength)
            ));
            const rushEnd = Math.min(torrentData.torrent.pieces.length - 1, targetPiece + 8);

            if (torrentData.torrent.critical && targetPiece <= rushEnd) {
                torrentData.torrent.critical(targetPiece, rushEnd);
            }
        }
    } catch (err) {}

    const chunkSize = end - start + 1;

    res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${file.length}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": getMimeType(file.name)
    });

    const stream = file.createReadStream({ start, end });

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
