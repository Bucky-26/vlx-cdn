const express = require("express");
const path = require("path");
const {
    getMovieInfo,
    getTvEpisodeInfo,
    searchMovieTorrents,
    searchTvTorrents
} = require("../services/tmdbService");
const { prepareTorrentOnServer, prepareFastest } = require("../torrentManager");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// SSE Media Handler — streams data in phases so player starts immediately:
//   Phase 1 (~1-3s): TMDB metadata + source list (player can render UI)
//   Phase 2 (~3-8s): Stream ready confirmation (player starts video)
// ─────────────────────────────────────────────────────────────────────────────

async function handleMediaSSE(req, res, getInfo, searchTorrents) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();

    let closed = false;
    // Promise that resolves when client disconnects
    const disconnected = new Promise((resolve) => req.on("close", () => { closed = true; resolve(); }));

    function send(event, data) {
        if (closed) return;
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {}
    }

    try {
        // ── Phase 1: TMDB info + torrent search ─────────────────────────────
        const info = await getInfo();
        if (closed) return;

        const sources = await searchTorrents(info);
        if (closed) return;

        const bestSource = sources.length > 0 ? sources[0] : null;
        const qualitySet = new Set(sources.map((s) => s.quality));
        const qualities = ["4K", "1080p", "720p", "480p"].filter((q) => qualitySet.has(q));

        send("meta", {
            success: true,
            mediaType: info.mediaType,
            tmdb: info,
            sources,
            bestSource,
            qualities: qualities.length > 0 ? qualities : ["1080p"],
            currentQuality: bestSource ? bestSource.quality : "1080p",
            totalSources: sources.length
        });

        if (!bestSource) {
            send("error", { error: "No stream sources available for this title." });
            if (!closed) res.end();
            return;
        }

        // ── Phase 2: Race ALL sources — first one to connect wins ──────────────
        const durationSec = info.runtime ? info.runtime * 60 : (info.mediaType === "tv" ? 3000 : 7200);
        const streamPromise = prepareFastest(sources, durationSec);

        // Race: either stream is ready, or client disconnects
        const result = await Promise.race([
            streamPromise.then((data) => ({ ok: true, data })).catch((err) => ({ ok: false, err })),
            disconnected.then(() => ({ ok: false, disconnected: true }))
        ]);

        if (closed || result.disconnected) return; // client left, nothing to send

        if (result.ok) {
            const streamData = result.data;
            send("stream", {
                ...streamData,
                infoHash: streamData.infoHash,
                streamUrl: streamData.streamUrl,
                transcodeUrl: streamData.transcodeUrl
            });
        } else {
            console.log("SSE stream prep notice:", result.err && result.err.message);
            send("stream_error", { error: (result.err && result.err.message) || "Failed to connect to stream peers." });
        }

        if (!closed) res.end();
    } catch (err) {
        console.error("Media SSE handler error:", err.message);
        if (!closed) {
            try { send("error", { error: err.message || "Failed to load media" }); res.end(); } catch (e) {}
        }
    }
}

// Handler for Movie — JSON fallback for non-SSE clients
async function handleMovie(req, res) {
    const tmdbId = req.params.tmdbid;
    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
        return res.status(400).json({ error: "Invalid TMDB ID. Must be a numeric ID." });
    }

    // SSE mode (player.js uses this)
    if (req.headers.accept && req.headers.accept.includes("text/event-stream")) {
        return handleMediaSSE(
            req, res,
            () => getMovieInfo(tmdbId),
            (info) => searchMovieTorrents(info)
        );
    }

    // JSON fallback
    try {
        const movie = await getMovieInfo(tmdbId);
        const sources = await searchMovieTorrents(movie);
        const bestSource = sources.length > 0 ? sources[0] : null;

        if (bestSource) {
            const durationSec = movie.runtime ? movie.runtime * 60 : 7200;
            prepareFastest(sources, durationSec).catch((e) => {
                console.log("Auto-prepare stream notice:", e.message);
            });
        }

        const qualitySet = new Set(sources.map((s) => s.quality));
        const qualities = ["4K", "1080p", "720p", "480p"].filter((q) => qualitySet.has(q));

        return res.json({
            success: true,
            mediaType: "movie",
            tmdb: movie,
            sources,
            bestSource,
            qualities: qualities.length > 0 ? qualities : ["1080p"],
            currentQuality: bestSource ? bestSource.quality : "1080p",
            totalSources: sources.length
        });
    } catch (err) {
        console.error("TMDB Movie handler error:", err.message);
        return res.status(err.status || 500).json({ error: err.message || "Failed to fetch movie data" });
    }
}

// Handler for TV Episode
async function handleTv(req, res) {
    const tmdbId = req.params.tmdbid;
    const season = req.params.season;
    let episode = req.params.episode || req.params.epesode || "1";
    if (episode === "epesode" || episode === "episode") episode = "1";

    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
        return res.status(400).json({ error: "Invalid TMDB ID. Must be a numeric ID." });
    }
    if (!season || !/^\d+$/.test(season)) {
        return res.status(400).json({ error: "Invalid season number." });
    }
    if (!episode || !/^\d+$/.test(episode)) {
        return res.status(400).json({ error: "Invalid episode number." });
    }

    // SSE mode
    if (req.headers.accept && req.headers.accept.includes("text/event-stream")) {
        return handleMediaSSE(
            req, res,
            () => getTvEpisodeInfo(tmdbId, season, episode),
            (info) => searchTvTorrents(info)
        );
    }

    // JSON fallback
    try {
        const tv = await getTvEpisodeInfo(tmdbId, season, episode);
        const sources = await searchTvTorrents(tv);
        const bestSource = sources.length > 0 ? sources[0] : null;

        if (bestSource) {
            const durationSec = tv.runtime ? tv.runtime * 60 : 3000;
            prepareFastest(sources, durationSec).catch((e) => {
                console.log("Auto-prepare stream notice:", e.message);
            });
        }

        const qualitySet = new Set(sources.map((s) => s.quality));
        const qualities = ["4K", "1080p", "720p", "480p"].filter((q) => qualitySet.has(q));

        return res.json({
            success: true,
            mediaType: "tv",
            tmdb: tv,
            sources,
            bestSource,
            qualities: qualities.length > 0 ? qualities : ["1080p"],
            currentQuality: bestSource ? bestSource.quality : "1080p",
            totalSources: sources.length
        });
    } catch (err) {
        console.error("TMDB TV handler error:", err.message);
        return res.status(err.status || 500).json({ error: err.message || "Failed to fetch TV episode data" });
    }
}

// ── Browser Navigation Routes ────────────────────────────────────────────────
const playerHtmlPath = path.join(__dirname, "..", "..", "public", "player.html");

router.get("/movie/:tmdbid", (req, res) => {
    // SSE API request from player.js
    if (req.headers.accept && req.headers.accept.includes("text/event-stream")) {
        return handleMovie(req, res);
    }
    res.sendFile(playerHtmlPath);
});

router.get("/tv/:tmdbid/:season/:episode", (req, res) => {
    if (req.headers.accept && req.headers.accept.includes("text/event-stream")) {
        return handleTv(req, res);
    }
    res.sendFile(playerHtmlPath);
});

router.get("/tv/:tmdbid/:season/epesode/:episode", (req, res) => {
    if (req.headers.accept && req.headers.accept.includes("text/event-stream")) {
        return handleTv(req, res);
    }
    res.sendFile(playerHtmlPath);
});

router.get("/tv/:tmdbid/:season/epesode", (req, res) => {
    if (req.headers.accept && req.headers.accept.includes("text/event-stream")) {
        req.params.episode = "1";
        return handleTv(req, res);
    }
    res.sendFile(playerHtmlPath);
});

router.get("/tv/:tmdbid/:season", (req, res) => {
    if (req.headers.accept && req.headers.accept.includes("text/event-stream")) {
        req.params.episode = "1";
        return handleTv(req, res);
    }
    res.sendFile(playerHtmlPath);
});

module.exports = {
    mediaRouter: router,
    handleMovie,
    handleTv
};
