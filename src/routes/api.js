const express = require("express");
const { formatTime, formatBytes } = require("../utils");
const { probeTorrentDuration } = require("../probe");
const { getTorrentData, prepareTorrentOnServer, getSource, cleanStaleTorrents } = require("../torrentManager");
const { handleMovie, handleTv } = require("./media");
const { getTvSeasonEpisodes } = require("../services/tmdbService");

const router = express.Router();

// TMDB Media endpoints under /api — supports both JSON and SSE (Accept: text/event-stream)
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

// TV Season Episodes endpoint (for Netflix / HBO episode selection drawer)
router.get("/tv/:tmdbid/season/:season/episodes", async (req, res) => {
    try {
        const { tmdbid, season } = req.params;
        const data = await getTvSeasonEpisodes(tmdbid, season);
        return res.json(data);
    } catch (err) {
        return res.status(500).json({ error: err.message || "Failed to fetch season episodes" });
    }
});

// Server-side source selection & activation (when user switches quality or server)
router.post("/source/select", async (req, res) => {
    const { id, infoHash, duration } = req.body;
    const targetId = (id || infoHash || "").toLowerCase();

    if (!targetId) {
        return res.status(400).json({ error: "Stream source ID is required" });
    }

    try {
        // Use full cached source (has magnet URL) for reliable peer connection
        const cachedSource = getSource(targetId);
        const streamData = await prepareTorrentOnServer(cachedSource || targetId, duration);
        // Free bandwidth from other torrents once this one is active
        cleanStaleTorrents(targetId);
        return res.json({
            success: true,
            ...streamData
        });
    } catch (err) {
        console.error("Select source error:", err.message);
        return res.status(500).json({ error: err.message || "Failed to connect to stream source" });
    }
});

// Probe video duration
router.get("/duration/:infoHash", async (req, res) => {
    const infoHash = (req.params.infoHash || "").toLowerCase();
    const data = getTorrentData(infoHash);
    if (!data) return res.status(404).json({ error: "Stream not found" });

    if (data.duration && data.duration > 0) {
        return res.json({ duration: data.duration, durationFormatted: formatTime(data.duration) });
    }

    const dur = await probeTorrentDuration(data);
    res.json({ duration: dur || 0, durationFormatted: formatTime(dur || 0) });
});

// Buffer status (clean, no torrent branding)
router.get("/buffer-status/:infoHash", (req, res) => {
    const infoHash = (req.params.infoHash || "").toLowerCase();
    const data = getTorrentData(infoHash);
    if (!data || !data.torrent) return res.status(404).json({ error: "Stream not found" });

    const t = data.torrent;
    res.json({
        ready: true,
        speed: formatBytes(t.downloadSpeed || 0) + "/s",
        progress: Math.round((t.progress || 0) * 100)
    });
});

module.exports = router;
