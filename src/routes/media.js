const express = require("express");
const path = require("path");
const {
    getMovieInfo,
    getTvEpisodeInfo,
    searchMovieTorrents,
    searchTvTorrents
} = require("../services/tmdbService");

const router = express.Router();

// Handler for Movie (JSON API)
async function handleMovie(req, res) {
    const tmdbId = req.params.tmdbid;

    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
        return res.status(400).json({ error: "Invalid TMDB ID. Must be a numeric ID." });
    }

    try {
        const movie = await getMovieInfo(tmdbId);
        const torrents = await searchMovieTorrents(movie);
        const bestTorrent = torrents.length > 0 ? torrents[0] : null;

        return res.json({
            success: true,
            mediaType: "movie",
            tmdb: movie,
            bestTorrent,
            torrents,
            totalTorrents: torrents.length
        });
    } catch (err) {
        console.error("TMDB Movie handler error:", err.message);
        const status = err.status || 500;
        return res.status(status).json({
            error: err.message || "Failed to fetch movie data from TMDB"
        });
    }
}

// Handler for TV Episode (JSON API)
async function handleTv(req, res) {
    const tmdbId = req.params.tmdbid;
    const season = req.params.season;
    let episode = req.params.episode || req.params.epesode || "1";

    if (episode === "epesode" || episode === "episode") {
        episode = "1";
    }

    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
        return res.status(400).json({ error: "Invalid TMDB ID. Must be a numeric ID." });
    }
    if (!season || !/^\d+$/.test(season)) {
        return res.status(400).json({ error: "Invalid season number." });
    }
    if (!episode || !/^\d+$/.test(episode)) {
        return res.status(400).json({ error: "Invalid episode number." });
    }

    try {
        const tv = await getTvEpisodeInfo(tmdbId, season, episode);
        const torrents = await searchTvTorrents(tv);
        const bestTorrent = torrents.length > 0 ? torrents[0] : null;

        return res.json({
            success: true,
            mediaType: "tv",
            tmdb: tv,
            bestTorrent,
            torrents,
            totalTorrents: torrents.length
        });
    } catch (err) {
        console.error("TMDB TV handler error:", err.message);
        const status = err.status || 500;
        return res.status(status).json({
            error: err.message || "Failed to fetch TV episode data from TMDB"
        });
    }
}

// Browser navigation routes - always serve dedicated full-viewport player
const playerHtmlPath = path.join(__dirname, "..", "..", "public", "player.html");

router.get("/movie/:tmdbid", (req, res) => {
    res.sendFile(playerHtmlPath);
});

router.get("/tv/:tmdbid/:season/:episode", (req, res) => {
    res.sendFile(playerHtmlPath);
});

router.get("/tv/:tmdbid/:season/epesode/:episode", (req, res) => {
    res.sendFile(playerHtmlPath);
});

router.get("/tv/:tmdbid/:season/epesode", (req, res) => {
    res.sendFile(playerHtmlPath);
});

router.get("/tv/:tmdbid/:season", (req, res) => {
    res.sendFile(playerHtmlPath);
});

module.exports = {
    mediaRouter: router,
    handleMovie,
    handleTv
};
