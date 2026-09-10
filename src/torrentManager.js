// Store active torrents: infoHash -> { torrent, file, duration, probePromise, currentPiece, lastBufferedPiece }
const torrents = new Map();
let client = null;

async function initClient() {
    if (!client) {
        const { default: WebTorrent } = await import("webtorrent");
        client = new WebTorrent({
            maxConns: 350,
            dht: true,
            webSeeds: true,
            lsd: true,
            utPex: true,
            natUpnp: false,
            downloadLimit: -1,
            uploadLimit: -1
        });
        client.setMaxListeners(0);

        client.on("error", (error) => {
            console.error("Torrent client error:", error.message);
        });
    }
    return client;
}

function getClient() {
    return client;
}

function getTorrentData(infoHash) {
    return torrents.get((infoHash || "").toLowerCase());
}

function setTorrentData(infoHash, data) {
    torrents.set((infoHash || "").toLowerCase(), data);
}

function hasTorrent(infoHash) {
    return torrents.has((infoHash || "").toLowerCase());
}

/**
 * Prioritizes a rolling window of pieces around the active playback cursor.
 * - Critical pieces (target to target + rushCount): prioritized for immediate playback.
 * - Forward buffer (target to target + forwardCount): downloaded proactively by the swarm into chunk store.
 */
function prioritizeTorrentWindow(torrentData, targetPiece = 0, rushCount = 15, forwardCount = 60) {
    if (!torrentData || !torrentData.torrent || !torrentData.torrent.pieces) return;
    const { torrent, file } = torrentData;
    const totalPieces = torrent.pieces.length;
    if (totalPieces <= 0) return;

    const fileStart = file && file._startPiece !== undefined ? file._startPiece : 0;
    const fileEnd = file && file._endPiece !== undefined ? file._endPiece : totalPieces - 1;

    const start = Math.max(fileStart, Math.min(fileEnd, targetPiece));
    const rushEnd = Math.min(fileEnd, start + rushCount);
    const forwardEnd = Math.min(fileEnd, start + forwardCount);

    try {
        // 1. Container header & index critical for THIS specific file (not the whole torrent's piece 0)
        if (torrent.critical) {
            torrent.critical(fileStart, Math.min(fileEnd, fileStart + 3));
            if (fileEnd - fileStart > 6) {
                torrent.critical(fileEnd - 2, fileEnd);
            }
        }

        // If jumping forward within the file, deselect pieces before the seek point (preserving headers)
        if (targetPiece > fileStart + 6 && torrent.deselect) {
            try {
                torrent.deselect(fileStart + 4, targetPiece - 1);
            } catch (e) {}
        }

        // 2. Immediate rush pieces (critical hotswap)
        if (torrent.critical && start <= rushEnd) {
            torrent.critical(start, rushEnd);
        }

        // 3. Forward buffer (priority 5)
        if (torrent.select && start <= forwardEnd) {
            torrent.select(start, forwardEnd, 5);
        }

        torrentData.lastBufferedPiece = start;
    } catch (err) {
        // Safe catch - prevent any selection range errors
    }
}

/**
 * Frees up connections and bandwidth by destroying any background torrents
 * other than the currently playing infoHash.
 */
function cleanStaleTorrents(activeInfoHash) {
    if (!client || !client.torrents) return;
    const currentKey = (activeInfoHash || "").toLowerCase();

    for (const t of [...client.torrents]) {
        const hash = (t.infoHash || "").toLowerCase();
        if (hash !== currentKey) {
            console.log("Removing background torrent to maximize bandwidth and disk space:", t.name || hash);
            try {
                torrents.delete(hash);
                client.remove(t, { destroyStore: true });
            } catch (e) {}
        }
    }
}

const path = require("path");
const { VIDEO_EXTENSIONS, TRACKERS, isAudioIncompatible, formatTime, buildMagnet } = require("./utils");
const { probeTorrentDuration } = require("./probe");
const { generateStreamTicket } = require("./services/streamSecurity");

/**
 * Selects the correct video file from a torrent based on season/episode and fileIdx.
 * Supports:
 * - Direct index match from provider metadata (e.g. Torrentio fileIdx)
 * - S01E08 / S1E8 / S01.E08 / S1_E8
 * - 1x08 / 01x08
 * - E08 / E8 standalone
 * - Episode 8 / Ep 8 / Ep.08
 * - Leading numbers (08 - Title.mkv, 08.mkv)
 * - Season folder matching ("Season 2/03.mkv")
 * - Cross-season protection: heavily penalizes files with a different season tag
 */
function selectEpisodeFile(videoFiles, season, episode, preferredFileIdx = null) {
    if (!videoFiles || videoFiles.length === 0) return null;

    if (!episode || videoFiles.length <= 1) {
        // Movie or single-file torrent: pick the largest
        return videoFiles.sort((a, b) => b.length - a.length)[0];
    }

    const epNum = parseInt(episode, 10);
    const seasonNum = season ? parseInt(season, 10) : null;
    const sPad = seasonNum ? String(seasonNum).padStart(2, "0") : null;
    const ePad = String(epNum).padStart(2, "0");

    let bestFile = null;
    let bestScore = -1;

    for (const f of videoFiles) {
        const fullPath = (f.path || f.name || "").replace(/\\/g, "/");
        const name = path.basename(fullPath);
        const lower = fullPath.toLowerCase();
        const baseLower = name.toLowerCase();
        let score = 0;

        // Pattern 1: S01E08 or S1E8
        const sXeY = baseLower.match(/s(\d{1,2})[\s._-]*e(\d{1,3})/i) || lower.match(/s(\d{1,2})[\s._-]*e(\d{1,3})/i);
        if (sXeY) {
            const fileSeason = parseInt(sXeY[1], 10);
            const fileEp = parseInt(sXeY[2], 10);
            if (fileEp === epNum) {
                score = 100;
                if (seasonNum && fileSeason === seasonNum) score += 60;
                else if (seasonNum && fileSeason !== seasonNum) score -= 80;
            } else {
                continue; // Explicit wrong episode
            }
        }

        // Pattern 2: 1x08 or 01x08
        if (score === 0) {
            const xPattern = baseLower.match(/(\d{1,2})\s*x\s*(\d{1,3})/i) || lower.match(/(\d{1,2})\s*x\s*(\d{1,3})/i);
            if (xPattern) {
                const fileSeason = parseInt(xPattern[1], 10);
                const fileEp = parseInt(xPattern[2], 10);
                if (fileEp === epNum) {
                    score = 90;
                    if (seasonNum && fileSeason === seasonNum) score += 60;
                    else if (seasonNum && fileSeason !== seasonNum) score -= 80;
                } else {
                    continue; // Explicit wrong episode
                }
            }
        }

        // Pattern 3: E08 standalone (no S prefix)
        if (score === 0) {
            const eOnly = baseLower.match(/(?:^|[^a-z0-9])e(\d{1,3})(?:[^a-z0-9]|$)/i);
            if (eOnly && parseInt(eOnly[1], 10) === epNum) {
                score = 70;
            }
        }

        // Pattern 4: "Episode 8", "Episode.8", "Episode_8", "Ep 8"
        if (score === 0) {
            const epWord = baseLower.match(/(?:episode|ep)[\s._-]*(\d{1,3})/i);
            if (epWord && parseInt(epWord[1], 10) === epNum) {
                score = 60;
            }
        }

        // Pattern 5: Leading or bare numbers like "08 - Title.mkv", "08.mkv", ".08."
        if (score === 0) {
            const leading = baseLower.match(/^(\d{1,3})[\s._-]/);
            if (leading && parseInt(leading[1], 10) === epNum) {
                score = 50;
            } else {
                const bare = baseLower.match(/[\s._-](\d{2,3})[\s._-]/g);
                if (bare) {
                    for (const m of bare) {
                        const num = parseInt(m.replace(/[^\d]/g, ""), 10);
                        if (num === epNum) {
                            score = 40;
                            break;
                        }
                    }
                }
            }
        }

        // Bonus for matching season in directory structure (e.g. "Season 2/03.mkv")
        if (score > 0 && seasonNum) {
            const hasSeasonInPath = lower.includes(`season ${seasonNum}`) ||
                                   lower.includes(`season ${sPad}`) ||
                                   lower.includes(`season_${seasonNum}`) ||
                                   lower.includes(`season_${sPad}`) ||
                                   lower.includes(`s${sPad}`) ||
                                   lower.includes(`s${seasonNum}`);
            if (hasSeasonInPath) score += 20;
        }

        // Heavy penalty for sample or trailer video files
        if (baseLower.includes("sample") || lower.includes("/sample") || lower.includes(".sample") || baseLower.includes("trailer")) {
            score -= 150;
        }

        if (score > bestScore) {
            bestScore = score;
            bestFile = f;
        }
    }

    if (bestFile && bestScore > 0) {
        console.log(`Episode match: S${sPad || "?"}E${ePad} → ${path.basename(bestFile.name)} (score: ${bestScore})`);
        return bestFile;
    }

    // Secondary fallback: preferredFileIdx if provided
    if (typeof preferredFileIdx === "number" && preferredFileIdx >= 0) {
        const fileByIdx = videoFiles.find((f) => f._fileIdx === preferredFileIdx) || videoFiles[preferredFileIdx];
        if (fileByIdx) {
            console.log(`Matched episode by preferred file index ${preferredFileIdx}: ${fileByIdx.name}`);
            return fileByIdx;
        }
    }

    console.log(`No episode pattern match for E${ePad}, falling back to largest file`);
    return videoFiles.sort((a, b) => b.length - a.length)[0];
}

// Source cache: infoHash -> source
const sourcesCache = new Map();

function cacheSource(infoHash, source) {
    if (infoHash && source) {
        sourcesCache.set((infoHash || "").toLowerCase(), source);
    }
}

function getSource(infoHash) {
    return sourcesCache.get((infoHash || "").toLowerCase());
}

// In-flight preparation promises: infoHash -> Promise
const pendingPreparations = new Map();

async function prepareTorrentOnServer(sourceOrHash, duration = 0, options = {}) {
    let source = null;
    let infoHash = "";
    let magnet = "";

    if (typeof sourceOrHash === "string") {
        infoHash = sourceOrHash.toLowerCase();
        source = getSource(infoHash);
        if (source && source.magnet) magnet = source.magnet;
    } else if (sourceOrHash && typeof sourceOrHash === "object") {
        source = sourceOrHash;
        infoHash = (source.infoHash || source.id || "").toLowerCase();
        magnet = source.magnet || (getSource(infoHash) && getSource(infoHash).magnet) || "";
    }

    if (!infoHash) throw new Error("Invalid stream source");
    if (!magnet) magnet = buildMagnet(infoHash, source && source.name ? source.name : "video");
    if (source) cacheSource(infoHash, { ...source, magnet });

    const preferredIdx = typeof options.fileIdx === "number" ? options.fileIdx : (source && typeof source.fileIdx === "number" ? source.fileIdx : null);

    // Already active — but re-select file if episode changed (season pack)
    if (hasTorrent(infoHash)) {
        const data = getTorrentData(infoHash);
        if (duration && (!data.duration || data.duration <= 0)) data.duration = Number(duration);

        // If we have episode info and there are multiple video files, re-select the right one
        if ((options.episode || preferredIdx !== null) && data.torrent && data.torrent.files) {
            const videoFiles = data.torrent.files.filter((f) => {
                const ext = path.extname(f.name).toLowerCase();
                return VIDEO_EXTENSIONS.includes(ext);
            });
            if (videoFiles.length > 1) {
                const correctFile = selectEpisodeFile(videoFiles, options.season, options.episode, preferredIdx);
                if (correctFile && correctFile !== data.file) {
                    try { data.torrent.files.forEach((f) => f.deselect()); } catch (e) {}
                    try { correctFile.select(); } catch (e) {}
                    data.file = correctFile;
                    data.currentPiece = correctFile._startPiece || 0;
                    data.lastBufferedPiece = correctFile._startPiece || 0;
                    data.duration = 0; // Reset — different episode has different duration
                    prioritizeTorrentWindow(data, correctFile._startPiece || 0, 15, 60);
                    probeTorrentDuration(data).catch(() => {});
                    console.log(`Re-selected episode file: ${correctFile.name} (${infoHash})`);
                }
            }
        }

        const fileIdx = data.torrent && data.torrent.files ? data.torrent.files.indexOf(data.file) : -1;
        const ticket = generateStreamTicket({ infoHash, fileIdx: fileIdx >= 0 ? fileIdx : null, req: options.req });

        return {
            id: infoHash, infoHash,
            ticket,
            fileIdx: fileIdx >= 0 ? fileIdx : undefined,
            filename: data.file.name,
            streamUrl: `/stream/play/${ticket}`,
            transcodeUrl: `/stream/play/${ticket}?transcode=audio`,
            duration: data.duration || 0,
            durationFormatted: formatTime(data.duration || 0),
            needsTranscode: isAudioIncompatible(data.file.name)
        };
    }

    // Return in-flight preparation if already in progress
    if (pendingPreparations.has(infoHash)) {
        return pendingPreparations.get(infoHash);
    }

    const c = await initClient();
    if (!c) throw new Error("Streaming engine is initializing");

    // NOTE: cleanStaleTorrents is NOT called here so parallel racing works correctly.
    // It is called externally after a winner is determined (in prepareFastest or caller).

    // Build a pure Promise (no async executor) to avoid the new Promise(async...) anti-pattern
    // which causes Node.js to fire unhandledRejection for the inner async function's promise.
    const prepPromise = new Promise((resolve, reject) => {
        let responded = false;
        let timeoutTimer = null;

        function done(err, result) {
            if (responded) return;
            responded = true;
            clearTimeout(timeoutTimer);
            if (err) reject(err);
            else resolve(result);
        }

        timeoutTimer = setTimeout(() => {
            done(new Error("Timeout connecting to media stream peers. Please try another server or quality."));
        }, 12000);

        let readyRan = false;
        function onReady(torrent) {
            if (readyRan) return;
            readyRan = true;

            const videoFiles = torrent.files.filter((f) => {
                const ext = path.extname(f.name).toLowerCase();
                return VIDEO_EXTENSIONS.includes(ext);
            });

            if (videoFiles.length === 0) {
                return done(new Error("No playable video tracks found in this stream source."));
            }

            const file = selectEpisodeFile(videoFiles, options.season, options.episode, preferredIdx);

            try { torrent.files.forEach((f) => f.deselect()); } catch (e) {}
            try { file.select(); } catch (e) {}

            const torrentData = {
                torrent, file,
                duration: Number(duration) || 0,
                currentPiece: file._startPiece || 0,
                lastBufferedPiece: file._startPiece || 0
            };
            setTorrentData(infoHash, torrentData);
            prioritizeTorrentWindow(torrentData, file._startPiece || 0, 15, 60);
            probeTorrentDuration(torrentData).catch(() => {});

            console.log(`Server prepared stream for ${file.name} (${infoHash})`);

            const fileIdx = torrent.files ? torrent.files.indexOf(file) : -1;
            const ticket = generateStreamTicket({ infoHash, fileIdx: fileIdx >= 0 ? fileIdx : null, req: options.req });

            done(null, {
                id: infoHash, infoHash,
                ticket,
                fileIdx: fileIdx >= 0 ? fileIdx : undefined,
                filename: file.name,
                streamUrl: `/stream/play/${ticket}`,
                transcodeUrl: `/stream/play/${ticket}?transcode=audio`,
                duration: torrentData.duration || 0,
                durationFormatted: formatTime(torrentData.duration || 0),
                needsTranscode: isAudioIncompatible(file.name)
            });
        }

        // Check if torrent is already in client (synchronous lookup in c.torrents array)
        const existing = c.torrents
            ? c.torrents.find((t) => t.infoHash && t.infoHash.toLowerCase() === infoHash)
            : null;

        if (existing) {
            if (existing.ready || (existing.files && existing.files.length > 0)) {
                onReady(existing);
            } else {
                existing.once("ready", () => onReady(existing));
                existing.once("error", (err) => done(err));
            }
            return;
        }

        const torrentOpts = {
            destroyStoreOnDestroy: true,
            deselect: true,
            maxConns: 120,
            announce: TRACKERS
        };

        try {
            const torrent = c.add(magnet, torrentOpts, (t) => {
                try { t.setMaxListeners(0); } catch (e) {}
                onReady(t);
            });
            try { torrent.setMaxListeners(0); } catch (e) {}
            torrent.on("error", (err) => done(err));
            torrent.on("ready", () => onReady(torrent));
        } catch (err) {
            done(err);
        }
    });

    pendingPreparations.set(infoHash, prepPromise);
    prepPromise
        .finally(() => { pendingPreparations.delete(infoHash); })
        .catch(() => {}); // suppress rejection from .finally()'s returned promise

    return prepPromise;
}

/**
 * Fast parallel stream discovery:
 * Races top 5 sources for metadata simultaneously with deselect: true (zero video bandwidth).
 * Resolves immediately with the fastest connecting source (typically 2-4s).
 * Immediately removes losers to dedicate 100% bandwidth to the winner.
 */
async function prepareFastest(sources, duration = 0, options = {}) {
    if (!sources || sources.length === 0) {
        throw new Error("No stream sources available");
    }

    const candidates = sources.slice(0, 5);

    return new Promise((resolve, reject) => {
        let won = false;
        let settled = 0;
        const total = candidates.length;

        const timeoutTimer = setTimeout(() => {
            if (!won) {
                won = true;
                reject(new Error("All stream sources timed out. Please try another server or quality."));
            }
        }, 13000);

        candidates.forEach((src) => {
            prepareTorrentOnServer(src, duration, options)
                .then((result) => {
                    if (won) return;
                    won = true;
                    clearTimeout(timeoutTimer);
                    const winnerHash = (result.infoHash || "").toLowerCase();
                    // Destroy losing candidates immediately to allocate full bandwidth to winner
                    setTimeout(() => cleanStaleTorrents(winnerHash), 50);
                    resolve(result);
                })
                .catch((err) => {
                    settled++;
                    if (!won && settled >= total) {
                        clearTimeout(timeoutTimer);
                        reject(new Error("All stream sources timed out. Please try another server or quality."));
                    }
                });
        });
    });
}

function destroyClient() {
    return new Promise((resolve) => {
        if (client) {
            client.destroy(() => {
                client = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}

module.exports = {
    torrents,
    initClient,
    getClient,
    getTorrentData,
    setTorrentData,
    hasTorrent,
    prioritizeTorrentWindow,
    cleanStaleTorrents,
    prepareTorrentOnServer,
    prepareFastest,
    cacheSource,
    getSource,
    destroyClient
};
