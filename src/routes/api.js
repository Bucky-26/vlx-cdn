const express = require("express");
const path = require("path");
const { formatTime, formatBytes, buildMagnet, isAudioIncompatible, VIDEO_EXTENSIONS } = require("../utils");
const { probeTorrentDuration } = require("../probe");
const { getClient, getTorrentData, setTorrentData, hasTorrent } = require("../torrentManager");

const router = express.Router();

router.get("/search", async (req, res) => {
    const query = req.query.q;
    if (!query || !query.trim()) {
        return res.status(400).json({ error: "Search query parameter 'q' is required" });
    }

    try {
        // Search video category (cat=200: Movies, TV Shows, HD, etc.)
        let url = `https://apibay.org/q.php?q=${encodeURIComponent(query.trim())}&cat=200`;
        let response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        let data = await response.json();

        // Fallback to all categories if video category returned empty
        if (!Array.isArray(data) || data.length === 0 || data[0].name === "No results returned") {
            url = `https://apibay.org/q.php?q=${encodeURIComponent(query.trim())}`;
            response = await fetch(url, { signal: AbortSignal.timeout(8000) });
            data = await response.json();
        }

        if (!Array.isArray(data) || data.length === 0 || data[0].name === "No results returned") {
            return res.json({ results: [] });
        }

        const results = data.map((item) => {
            const seeders = parseInt(item.seeders, 10) || 0;
            const leechers = parseInt(item.leechers, 10) || 0;
            const size = parseInt(item.size, 10) || 0;
            const hash = (item.info_hash || "").toLowerCase();
            const magnet = buildMagnet(hash, item.name);

            return {
                id: item.id,
                name: item.name,
                infoHash: hash,
                seeders,
                leechers,
                size,
                sizeFormatted: formatBytes(size),
                magnet
            };
        });

        // Sort descending by seeders
        results.sort((a, b) => b.seeders - a.seeders);

        res.json({ results });
    } catch (err) {
        console.error("Torrent search error:", err.message);
        res.status(500).json({ error: "Failed to search torrents: " + err.message });
    }
});

router.post("/torrent", async (req, res) => {
    const { magnet } = req.body;

    if (!magnet || !magnet.startsWith("magnet:?")) {
        return res.status(400).json({ error: "Invalid magnet link" });
    }

    const infoHashMatch = magnet.match(/xt=urn:btih:([^&]+)/i);
    if (!infoHashMatch) {
        return res.status(400).json({ error: "Could not find torrent info hash" });
    }

    const infoHash = infoHashMatch[1].toLowerCase();

    // Already cached in torrents map
    if (hasTorrent(infoHash)) {
        const data = getTorrentData(infoHash);
        return res.json({
            filename: data.file.name,
            streamUrl: `/stream/${infoHash}`,
            transcodeUrl: `/stream/${infoHash}?transcode=audio`,
            infoHash: infoHash,
            duration: data.duration || 0,
            durationFormatted: formatTime(data.duration || 0),
            needsTranscode: isAudioIncompatible(data.file.name)
        });
    }

    const client = getClient();
    if (!client) {
        return res.status(503).json({
            error: "Torrent client is initializing, please try again in a moment."
        });
    }

    let responded = false;

    async function setupTorrent(torrent) {
        if (responded) return;
        responded = true;

        torrent.on("error", (err) => {
            console.error("Torrent error:", err.message);
        });

        // Find the largest video file
        const videoFiles = torrent.files.filter((file) => {
            const ext = path.extname(file.name).toLowerCase();
            return VIDEO_EXTENSIONS.includes(ext);
        });

        if (videoFiles.length === 0) {
            return res.status(400).json({ error: "No video files found in this torrent." });
        }

        const file = videoFiles.sort((a, b) => b.length - a.length)[0];

        const torrentData = {
            torrent,
            file,
            duration: 0
        };
        setTorrentData(infoHash, torrentData);

        // Head and tail piece prioritization for instant seeking:
        // Pre-fetch container headers at start (pieces 0-3) and index/cues at end of torrent
        if (torrent.pieces && torrent.pieces.length > 0) {
            const totalPieces = torrent.pieces.length;
            if (torrent.critical) {
                torrent.critical(0, Math.min(totalPieces - 1, 3));
                if (totalPieces > 8) {
                    torrent.critical(totalPieces - 4, totalPieces - 1);
                }
            }
        }

        // Probe duration with unified promise, give it up to 1200ms to resolve synchronously
        try {
            const dur = await Promise.race([
                probeTorrentDuration(torrentData),
                new Promise((r) => setTimeout(() => r(0), 1200))
            ]);
            if (dur > 0) {
                torrentData.duration = dur;
            }
        } catch (e) {}

        console.log("Selected video:", file.name);

        return res.json({
            filename: file.name,
            streamUrl: `/stream/${infoHash}`,
            transcodeUrl: `/stream/${infoHash}?transcode=audio`,
            infoHash: infoHash,
            duration: torrentData.duration || 0,
            durationFormatted: formatTime(torrentData.duration || 0),
            needsTranscode: isAudioIncompatible(file.name)
        });
    }

    // Check if torrent already exists in client
    try {
        const existing = await client.get(infoHash);
        if (existing) {
            console.log("Found existing torrent in client:", existing.name || infoHash);
            if (existing.ready || (existing.files && existing.files.length > 0)) {
                return setupTorrent(existing);
            }
            // If it exists but isn't ready, remove it so we can re-add cleanly
            try {
                await client.remove(existing);
                console.log("Removed stale unready torrent instance to reconnect");
            } catch (e) {}
        }
    } catch (e) {
        console.log("client.get notice:", e.message);
    }

    console.log("Adding torrent:", infoHash);

    // Timeout after 30 seconds if peers do not send metadata
    const timeoutTimer = setTimeout(() => {
        if (!responded) {
            responded = true;
            res.status(504).json({
                error: "Timeout searching for torrent metadata. Please ensure the magnet link has active seeders or try again."
            });
        }
    }, 30000);

    try {
        const torrent = client.add(magnet, (t) => {
            clearTimeout(timeoutTimer);
            console.log("Torrent metadata received:", t.name);
            setupTorrent(t);
        });

        torrent.on("error", (err) => {
            clearTimeout(timeoutTimer);
            console.error("Torrent error:", err.message);
            if (!responded) {
                responded = true;
                res.status(500).json({ error: "Torrent error: " + err.message });
            }
        });

        torrent.on("ready", () => {
            clearTimeout(timeoutTimer);
            setupTorrent(torrent);
        });
    } catch (err) {
        clearTimeout(timeoutTimer);
        console.error("client.add error:", err.message);
        if (!responded) {
            responded = true;
            return res.status(500).json({ error: err.message });
        }
    }
});

router.get("/duration/:infoHash", async (req, res) => {
    const infoHash = (req.params.infoHash || "").toLowerCase();
    const data = getTorrentData(infoHash);
    if (!data) return res.status(404).json({ error: "Torrent not found" });

    if (data.duration && data.duration > 0) {
        return res.json({ duration: data.duration, durationFormatted: formatTime(data.duration) });
    }

    const dur = await probeTorrentDuration(data);
    res.json({ duration: dur || 0, durationFormatted: formatTime(dur || 0) });
});

// TMDB Media endpoints under /api
const { handleMovie, handleTv } = require("./media");
router.get("/movie/:tmdbid", handleMovie);
router.get("/tv/:tmdbid/:season/:episode", handleTv);
router.get("/tv/:tmdbid/:season/epesode/:episode", handleTv);
router.get("/tv/:tmdbid/:season/epesode", (req, res) => {
    req.params.episode = "1";
    return handleTv(req, res);
});
router.get("/tv/:tmdbid/:season", (req, res) => {
    req.params.episode = "1";
    return handleTv(req, res);
});

module.exports = router;

