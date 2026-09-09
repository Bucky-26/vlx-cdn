const { buildMagnet, formatBytes } = require("../utils");
const { cacheSource } = require("../torrentManager");

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

const tmdbCache = new Map();

function getCached(key) {
    const item = tmdbCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
        tmdbCache.delete(key);
        return null;
    }
    return item.data;
}

function setCached(key, data, ttlMs = 1800000) {
    tmdbCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

async function getMovieInfo(tmdbId) {
    const cacheKey = `movie_${tmdbId}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const data = await tmdbFetch(`/movie/${tmdbId}`);
    const result = {
        id: data.id,
        mediaType: "movie",
        title: data.title,
        originalTitle: data.original_title,
        originalLanguage: (data.original_language || "en").toLowerCase(),
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

    setCached(cacheKey, result);
    return result;
}

async function getTvEpisodeInfo(tmdbId, season, episode) {
    const cacheKey = `tv_${tmdbId}_${season}_${episode}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const [tvData, epData, extData] = await Promise.all([
        tmdbFetch(`/tv/${tmdbId}`),
        tmdbFetch(`/tv/${tmdbId}/season/${season}/episode/${episode}`),
        tmdbFetch(`/tv/${tmdbId}/external_ids`).catch(() => ({}))
    ]);

    const result = {
        id: tvData.id,
        mediaType: "tv",
        showName: tvData.name,
        originalLanguage: (tvData.original_language || "en").toLowerCase(),
        season: parseInt(season, 10),
        episode: parseInt(episode, 10),
        episodeTitle: epData.name || `Episode ${episode}`,
        airDate: epData.air_date || null,
        imdbId: extData.imdb_id || null,
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

    setCached(cacheKey, result);
    return result;
}

// Provider 1: Apibay (The Pirate Bay)
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
                provider: "ThePirateBay",
                streamTitle: item.name,
                magnet,
                streamUrl: `/stream/${hash}`,
                transcodeUrl: `/stream/${hash}?transcode=audio`
            };
        });
    } catch (e) {
        console.error("Apibay search error:", e.message);
        return [];
    }
}

// Provider 2: Torrentio Multi-Provider Scraper (TorrentGalaxy, 1337x, RARBG, etc.)
async function searchTorrentio(type, id) {
    if (!id) return [];
    try {
        const url = type === "series"
            ? `https://torrentio.strem.fun/stream/series/${id}.json`
            : `https://torrentio.strem.fun/stream/movie/${id}.json`;

        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [];
        const data = await res.json();
        const streams = data.streams || [];

        return streams.map((s) => {
            const titleLines = (s.title || "").split("\n");
            const filename = s.behaviorHints?.filename || titleLines[0];
            const hash = (s.infoHash || "").toLowerCase();
            const seedMatch = (s.title || "").match(/👤\s*(\d+)/);
            const sizeMatch = (s.title || "").match(/💾\s*([0-9.]+)\s*([KMGT]?B)/i);
            const provMatch = (s.title || "").match(/⚙️\s*([^\n]+)/);

            let sizeBytes = 0;
            if (sizeMatch) {
                const num = parseFloat(sizeMatch[1]);
                const unit = sizeMatch[2].toUpperCase();
                const mult = unit === "GB" ? 1073741824 : unit === "MB" ? 1048576 : 1024;
                sizeBytes = Math.round(num * mult);
            }

            const provider = provMatch ? provMatch[1].trim() : "Torrentio";
            const seeders = seedMatch ? parseInt(seedMatch[1], 10) : 0;
            const magnet = buildMagnet(hash, filename);

            return {
                id: hash,
                name: filename,
                infoHash: hash,
                seeders,
                leechers: 0,
                size: sizeBytes,
                sizeFormatted: formatBytes(sizeBytes),
                provider,
                streamTitle: s.title || "",
                magnet,
                streamUrl: `/stream/${hash}`,
                transcodeUrl: `/stream/${hash}?transcode=audio`
            };
        }).filter((item) => item.infoHash && item.name);
    } catch (e) {
        console.error("Torrentio search error:", e.message);
        return [];
    }
}

// Provider 3: YTS / YIFY (Fast Web MP4 Movies)
async function searchYts(query) {
    if (!query) return [];
    try {
        const url = `https://yts.bz/api/v2/list_movies.json?query_term=${encodeURIComponent(query.trim())}&limit=10`;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return [];
        const data = await res.json();
        const movies = data.data?.movies || [];
        const results = [];

        for (const m of movies) {
            if (!m.torrents) continue;
            for (const t of m.torrents) {
                const hash = (t.hash || "").toLowerCase();
                const filename = `${m.title} (${m.year}) [${t.quality || "1080p"}] [YTS]`;
                const seeders = parseInt(t.seeds, 10) || 0;
                const leechers = parseInt(t.peers, 10) || 0;
                const size = t.size_bytes || 0;
                const magnet = buildMagnet(hash, filename);

                results.push({
                    id: hash,
                    name: filename,
                    infoHash: hash,
                    seeders,
                    leechers,
                    size,
                    sizeFormatted: formatBytes(size),
                    provider: "YTS",
                    streamTitle: filename,
                    magnet,
                    streamUrl: `/stream/${hash}`,
                    transcodeUrl: `/stream/${hash}?transcode=audio`
                });
            }
        }
        return results;
    } catch (e) {
        console.error("YTS search error:", e.message);
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

    // Trusted web-streaming groups bonus (English original audio)
    if (
        name.includes("yify") ||
        name.includes("yts") ||
        name.includes("rarbg") ||
        name.includes("psa") ||
        name.includes("galaxyrg") ||
        name.includes("galaxytv") ||
        name.includes("megusta") ||
        name.includes("eztv") ||
        name.includes("qxr") ||
        name.includes("sparks") ||
        name.includes("flux") ||
        name.includes("kogi") ||
        name.includes("ntb")
    ) {
        score += 20;
    }

    // Heavy penalty for non-English audio on English titles
    if (hasNonEnglishAudio(torrent.name, torrent.streamTitle, true)) {
        score -= 1000;
    }

    return Math.round(score);
}

function hasNonEnglishAudio(name, streamTitle = "", isEnglishMedia = true) {
    if (!isEnglishMedia) return false;
    const n = (name || "").toLowerCase();
    const st = (streamTitle || "").toLowerCase();
    const text = `${n} ${st}`;

    // 1. Cyrillic characters (Russian, Ukrainian, etc.)
    if (/[\u0400-\u04FF]/.test(text)) return true;

    // 2. Foreign release / dubbing groups and sites
    const foreignGroups = [
        "lostfilm", "newstudio", "hdrezka", "rezka", "kuraj-bambey", "kuraj",
        "baibako", "coldfilm", "exkinoray", "alexfilm", "jaskier", "red head sound",
        "rhs", "viruseproject", "gears media", "hamsterstudio", "sokolov",
        "kinozal", "rutracker", "rutor", "ilcorsaronero", "sp33dy94", "mircrew",
        "lullozzo", "alusia", "tntvillage", "mirc"
    ];
    for (const g of foreignGroups) {
        if (text.includes(g)) return true;
    }

    // 3. Dub indicators in release name
    if (/\b(dublado|dubbing|lektor(\s*pl)?|synchro)\b/i.test(text)) {
        return true;
    }
    if (/\b(dub|dubbed)\b/i.test(text) && !/\b(eng|english)\s*(dub|dubbed)\b/i.test(text)) {
        return true;
    }

    // 4. Foreign audio listed first in dual audio: ITA.ENG, RUS.ENG, HINDI.ENG, etc.
    if (/\b(ita|rus|hindi|fre|french|ger|german|spa|spanish|latino)[._\s\-\/]+(eng|english)\b/i.test(text)) {
        return true;
    }

    // 5. Torrentio emoji flags: has foreign audio flag without English
    const foreignFlags = ["🇮🇹", "🇷🇺", "🇺🇦", "🇫🇷", "🇪🇸", "🇩🇪", "🇵🇹", "🇧🇷", "🇮🇳", "🇨🇿", "🇵🇱", "🇹🇷"];
    const hasForeignFlag = foreignFlags.some((f) => text.includes(f));
    const hasEngFlag = text.includes("🇬🇧") || text.includes("🇺🇸");
    if (hasForeignFlag && !hasEngFlag) return true;

    // 6. Standalone foreign language tokens
    const foreignTokens = [
        "french", "truefrench", "vff", "vfq", "vf2", "subfrench",
        "german", "deutsch",
        "italian", "ita",
        "castellano", "latino", "espanol", "español",
        "russian", "rus",
        "hindi", "tamil", "telugu",
        "polish", "polski"
    ];

    for (const tok of foreignTokens) {
        const re = new RegExp(`(^|[._\\-\\s\\[\\(])${tok}([._\\-\\s\\]\\)]|$)`, "i");
        if (re.test(n)) {
            // Check if it specifically denotes subtitles rather than audio dub
            const subRe = new RegExp(`${tok}[._\\-\\s]*(sub|subs|subtitles)`, "i");
            const subReBefore = new RegExp(`(sub|subs|subtitles)[._\\-\\s]*${tok}`, "i");
            if (subRe.test(n) || subReBefore.test(n)) {
                continue;
            }
            const hasEngExplicit = /\b(eng|english)\b/i.test(n) || text.includes("🇬🇧") || text.includes("🇺🇸");
            if (!hasEngExplicit) {
                return true;
            }
        }
    }

    return false;
}

function extractQuality(name) {
    if (!name) return "1080p";
    const n = name.toLowerCase();
    if (n.includes("2160p") || n.includes("4k") || n.includes("uhd")) return "4K";
    if (n.includes("1080p") || n.includes("1080i") || n.includes("fhd")) return "1080p";
    if (n.includes("720p") || n.includes("hd")) return "720p";
    if (n.includes("480p") || n.includes("sd") || n.includes("dvd")) return "480p";
    return "1080p";
}

function getTop3ServersByPeers(results, isEnglishMedia = true) {
    const clean = [];
    const cam = [];

    for (const item of results) {
        // Exclude foreign audio dubs for English media
        if (isEnglishMedia && hasNonEnglishAudio(item.name, item.streamTitle, true)) {
            continue;
        }

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
        item.quality = extractQuality(item.name);

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

    // Return top servers formatted cleanly without size or torrent branding
    const topServers = sorted.slice(0, 5).map((item, idx) => {
        // Cache source on server side so it can be streamed without client sending magnets
        cacheSource(item.infoHash, item);

        return {
            id: item.infoHash,
            infoHash: item.infoHash,
            serverIndex: idx + 1,
            name: item.name,
            quality: item.quality,
            label: `Server ${idx + 1} (${item.quality})`,
            streamUrl: `/stream/${item.infoHash}`,
            transcodeUrl: `/stream/${item.infoHash}?transcode=audio`
        };
    });

    return topServers;
}

async function searchMovieTorrents(movie) {
    const isEnglishMedia = !movie.originalLanguage || movie.originalLanguage === "en";
    const cacheKey = `search_movie_en_${movie.id || movie.title}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const seen = new Set();
    const results = [];

    // Parallel multi-provider search: Torrentio + Apibay + YTS
    const queries = [];

    // 1. Torrentio (aggregates TorrentGalaxy, 1337x, RARBG, etc.)
    if (movie.imdbId) {
        queries.push(searchTorrentio("movie", movie.imdbId));
    }

    // 2. Apibay (The Pirate Bay)
    const titleQuery = movie.year ? `${movie.title} ${movie.year}` : movie.title;
    queries.push(searchApibay(titleQuery));

    // 3. YTS (Fast Web MP4)
    queries.push(searchYts(movie.title));

    const settled = await Promise.allSettled(queries);
    for (const res of settled) {
        if (res.status === "fulfilled" && Array.isArray(res.value)) {
            for (const item of res.value) {
                if (item.infoHash && !seen.has(item.infoHash)) {
                    seen.add(item.infoHash);
                    results.push(item);
                }
            }
        }
    }

    const top5 = getTop3ServersByPeers(results, isEnglishMedia);
    setCached(cacheKey, top5, 900000);
    return top5;
}

async function searchTvTorrents(tv) {
    const isEnglishMedia = !tv.originalLanguage || tv.originalLanguage === "en";
    const cacheKey = `search_tv_en_${tv.id}_${tv.season}_${tv.episode}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const seen = new Set();
    const results = [];

    const s = String(tv.season).padStart(2, "0");
    const e = String(tv.episode).padStart(2, "0");

    // Parallel multi-provider search: Torrentio + Apibay
    const queries = [];

    // 1. Torrentio (TorrentGalaxy, 1337x, RARBG, etc.)
    if (tv.imdbId) {
        queries.push(searchTorrentio("series", `${tv.imdbId}:${tv.season}:${tv.episode}`));
    }

    // 2. Apibay (The Pirate Bay standard patterns)
    queries.push(searchApibay(`${tv.showName} S${s}E${e}`));
    queries.push(searchApibay(`${tv.showName} Season ${tv.season} Episode ${tv.episode}`));

    const settled = await Promise.allSettled(queries);
    for (const res of settled) {
        if (res.status === "fulfilled" && Array.isArray(res.value)) {
            for (const item of res.value) {
                if (item.infoHash && !seen.has(item.infoHash)) {
                    seen.add(item.infoHash);
                    results.push(item);
                }
            }
        }
    }

    const top3 = getTop3ServersByPeers(results, isEnglishMedia);
    setCached(cacheKey, top3, 900000); // 15 min cache
    return top3;
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


