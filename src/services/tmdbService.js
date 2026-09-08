const { buildMagnet, formatBytes } = require("../utils");

const TMDB_API_KEY = process.env.APP_TMDB_API_KEY || "ad1819cb34ec21392f6ad54a9803a091";
const TMDB_READ_TOKEN = process.env.APP_TMDB_API_READ_ACCESS_TOKEN || "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJhZDE4MTljYjM0ZWMyMTM5MmY2YWQ1NGE5ODAzYTA5MSIsIm5iZiI6MTc0NjgwNzAwNy4wOTIsInN1YiI6IjY4MWUyOGRmODBjZTA0MThlYTZlM2NiOSIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.Cgmzm9rddrMOjd4QBLumcOfrjpO4H7sSu-hS05gYLRk";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p";

async function tmdbFetch(endpoint) {
    const url = `${TMDB_BASE_URL}${endpoint}`;
    const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${TMDB_READ_TOKEN}`
    };
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const err = new Error(errorData.status_message || `TMDB API error ${response.status}`);
        err.status = response.status;
        throw err;
    }
    return response.json();
}

async function getMovieInfo(tmdbId) {
    const data = await tmdbFetch(`/movie/${tmdbId}`);
    return {
        id: data.id,
        mediaType: "movie",
        title: data.title,
        originalTitle: data.original_title,
        year: data.release_date ? data.release_date.split("-")[0] : "",
        releaseDate: data.release_date || null,
        imdbId: data.imdb_id || null,
        overview: data.overview || "",
        tagline: data.tagline || "",
        runtime: data.runtime || null,
        voteAverage: data.vote_average ? parseFloat(data.vote_average.toFixed(1)) : 0,
        genres: (data.genres || []).map((g) => g.name),
        poster: data.poster_path ? `${TMDB_IMG_BASE}/w500${data.poster_path}` : null,
        backdrop: data.backdrop_path ? `${TMDB_IMG_BASE}/original${data.backdrop_path}` : null
    };
}

async function getTvEpisodeInfo(tmdbId, season, episode) {
    const [tvData, epData] = await Promise.all([
        tmdbFetch(`/tv/${tmdbId}`),
        tmdbFetch(`/tv/${tmdbId}/season/${season}/episode/${episode}`)
    ]);

    return {
        id: tvData.id,
        mediaType: "tv",
        showName: tvData.name,
        season: parseInt(season, 10),
        episode: parseInt(episode, 10),
        episodeTitle: epData.name || `Episode ${episode}`,
        airDate: epData.air_date || null,
        overview: epData.overview || tvData.overview || "",
        voteAverage: epData.vote_average
            ? parseFloat(epData.vote_average.toFixed(1))
            : tvData.vote_average
            ? parseFloat(tvData.vote_average.toFixed(1))
            : 0,
        genres: (tvData.genres || []).map((g) => g.name),
        runtime: epData.runtime || (tvData.episode_run_time && tvData.episode_run_time[0]) || 50,
        still: epData.still_path ? `${TMDB_IMG_BASE}/original${epData.still_path}` : null,
        poster: tvData.poster_path ? `${TMDB_IMG_BASE}/w500${tvData.poster_path}` : null,
        backdrop: tvData.backdrop_path ? `${TMDB_IMG_BASE}/original${tvData.backdrop_path}` : null
    };
}

async function searchApibay(query) {
    try {
        let url = `https://apibay.org/q.php?q=${encodeURIComponent(query.trim())}&cat=200`;
        let res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        let data = await res.json();

        if (!Array.isArray(data) || data.length === 0 || data[0].name === "No results returned") {
            url = `https://apibay.org/q.php?q=${encodeURIComponent(query.trim())}`;
            res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            data = await res.json();
        }

        if (!Array.isArray(data) || data.length === 0 || data[0].name === "No results returned") {
            return [];
        }

        return data.map((item) => {
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
                magnet,
                streamUrl: `/stream/${hash}`,
                transcodeUrl: `/stream/${hash}?transcode=audio`
            };
        });
    } catch (e) {
        console.error("Search error for query:", query, e.message);
        return [];
    }
}

function scoreTorrent(torrent, mediaType = "movie") {
    let score = 0;
    const name = (torrent.name || "").toLowerCase();
    const sizeGB = (torrent.size || 0) / (1024 * 1024 * 1024);
    const seeders = parseInt(torrent.seeders, 10) || 0;

    // Must have seeders
    if (seeders <= 0) return -1000;
    score += Math.min(seeders, 150) * 0.4; // up to 60 pts from seeders

    // Penalize low quality or CAM/TS/HDCAM/Screener
    if (
        name.includes("cam") ||
        name.includes("hdcam") ||
        name.includes("ts") ||
        name.includes("hdts") ||
        name.includes("telesync") ||
        name.includes("scr") ||
        name.includes("screener") ||
        name.includes("dvdscr")
    ) {
        score -= 150;
    }

    // Resolution preference: 1080p is optimal for web browser
    if (name.includes("1080p") || name.includes("1080")) {
        score += 35;
    } else if (name.includes("720p") || name.includes("720")) {
        score += 25;
    } else if (name.includes("2160p") || name.includes("4k")) {
        score += 15;
    } else if (name.includes("480p")) {
        score += 8;
    }

    // Browser compatibility
    if (name.includes(".mp4") || name.includes("mp4")) {
        score += 20; // native browser HTML5 video playback
    }
    if (name.includes("x264") || name.includes("h264") || name.includes("avc")) {
        score += 15;
    }
    if (name.includes("aac")) {
        score += 10;
    }
    if (name.includes("x265") || name.includes("hevc") || name.includes("10bit")) {
        score -= 5;
    }
    if (name.includes("dts") || name.includes("truehd") || name.includes("atmos")) {
        score -= 5;
    }

    // File size sanity check
    if (mediaType === "movie") {
        if (sizeGB >= 0.7 && sizeGB <= 3.5) {
            score += 20; // Ideal size for smooth web stream
        } else if (sizeGB > 3.5 && sizeGB <= 7.0) {
            score += 10;
        } else if (sizeGB > 10.0) {
            score -= 20;
        } else if (sizeGB < 0.5) {
            score -= 25;
        }
    } else {
        // TV episode
        if (sizeGB >= 0.2 && sizeGB <= 1.5) {
            score += 20; // Ideal episode size
        } else if (sizeGB > 1.5 && sizeGB <= 3.5) {
            score += 10;
        } else if (sizeGB > 5.0) {
            score -= 20;
        } else if (sizeGB < 0.08) {
            score -= 25;
        }
    }

    // Trusted web-streaming groups bonus
    if (
        name.includes("yify") ||
        name.includes("yts") ||
        name.includes("rarbg") ||
        name.includes("psa") ||
        name.includes("galaxyrg") ||
        name.includes("megusta") ||
        name.includes("eztv") ||
        name.includes("qxr")
    ) {
        score += 15;
    }

    return Math.round(score);
}

function getTop3ServersByPeers(results) {
    const clean = [];
    const cam = [];

    for (const item of results) {
        const name = (item.name || "").toLowerCase();
        const isCam =
            name.includes("cam") ||
            name.includes("hdcam") ||
            name.includes("ts") ||
            name.includes("hdts") ||
            name.includes("telesync") ||
            name.includes("scr") ||
            name.includes("screener");

        item.seeders = parseInt(item.seeders, 10) || 0;
        item.leechers = parseInt(item.leechers, 10) || 0;
        item.totalPeers = item.seeders + item.leechers;

        if (isCam) {
            cam.push(item);
        } else {
            clean.push(item);
        }
    }

    // Sort strictly by most peers (seeders first, then leechers)
    const sortByPeers = (a, b) => {
        if (b.seeders !== a.seeders) return b.seeders - a.seeders;
        return b.leechers - a.leechers;
    };

    clean.sort(sortByPeers);
    cam.sort(sortByPeers);

    // Prefer clean releases with active peers; fallback to cam only if no clean streams
    const sorted = clean.length > 0 ? clean : cam;

    // Return strictly the 3 best servers with the most peers
    return sorted.slice(0, 3);
}

async function searchMovieTorrents(movie) {
    const seen = new Set();
    const results = [];

    // 1. Try with title and year
    if (movie.year) {
        const query = `${movie.title} ${movie.year}`;
        const items = await searchApibay(query);
        for (const item of items) {
            if (!seen.has(item.infoHash)) {
                seen.add(item.infoHash);
                results.push(item);
            }
        }
    }

    // 2. If few results, fallback to title only
    if (results.length < 5) {
        const items = await searchApibay(movie.title);
        for (const item of items) {
            if (!seen.has(item.infoHash)) {
                seen.add(item.infoHash);
                results.push(item);
            }
        }
    }

    return getTop3ServersByPeers(results);
}

async function searchTvTorrents(tv) {
    const seen = new Set();
    const results = [];

    const s = String(tv.season).padStart(2, "0");
    const e = String(tv.episode).padStart(2, "0");

    // 1. Standard pattern: Show S01E01
    const q1 = `${tv.showName} S${s}E${e}`;
    const items1 = await searchApibay(q1);
    for (const item of items1) {
        if (!seen.has(item.infoHash)) {
            seen.add(item.infoHash);
            results.push(item);
        }
    }

    // 2. Alternative pattern: Show Season 1 Episode 1
    if (results.length < 3) {
        const q2 = `${tv.showName} Season ${tv.season} Episode ${tv.episode}`;
        const items2 = await searchApibay(q2);
        for (const item of items2) {
            if (!seen.has(item.infoHash)) {
                seen.add(item.infoHash);
                results.push(item);
            }
        }
    }

    return getTop3ServersByPeers(results);
}

module.exports = {
    TMDB_API_KEY,
    TMDB_READ_TOKEN,
    scoreTorrent,
    getTop3ServersByPeers,
    getMovieInfo,
    getTvEpisodeInfo,
    searchMovieTorrents,
    searchTvTorrents
};


