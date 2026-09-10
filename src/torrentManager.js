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

    const headerStart = fileStart;
    const headerEnd = Math.min(fileEnd, fileStart + 3);
    const footerStart = Math.max(fileStart, fileEnd - 2);
    const footerEnd = fileEnd;

    try {
        const lastPiece = typeof torrentData.lastBufferedPiece === "number" ? torrentData.lastBufferedPiece : -1;
        const isJump = lastPiece >= 0 && Math.abs(start - lastPiece) > 3;

        // When jumping / seeking across the media timeline:
        // Aggressively drop stale selections, clear obsolete critical flags, and cancel pending wire requests
        if (isJump || start > headerEnd + 2) {
            // 1. Prune internal WebTorrent selections list so swarm stops sequential walk from piece 0
            if (torrent._selections && Array.isArray(torrent._selections._items)) {
                torrent._selections._items = torrent._selections._items.filter(item => {
                    if (item.to <= headerEnd) return true;
                    if (item.from >= footerStart) return true;
                    return (item.to >= start && item.from <= forwardEnd);
                });
            }

            // 2. Clear out obsolete critical flags on pieces outside active seek window
            if (torrent._critical && Array.isArray(torrent._critical)) {
                for (let i = 0; i < torrent._critical.length; i++) {
                    if (i <= headerEnd || i >= footerStart) continue;
                    if (i >= start && i <= rushEnd) continue;
                    torrent._critical[i] = false;
                }
            }

            // 3. Deselect intermediate range before seek point
            if (start > headerEnd + 1 && torrent.deselect) {
                try {
                    torrent.deselect(headerEnd + 1, start - 1);
                } catch (e) {}
            }

            // 4. Cancel active in-flight block requests on peer wires for abandoned pieces
            if (torrent.wires && Array.isArray(torrent.wires)) {
                for (const wire of torrent.wires) {
                    if (!wire || !wire.requests || !wire.cancel) continue;
                    const pending = [...wire.requests];
                    for (const req of pending) {
                        const p = req.piece;
                        const isHeader = (p >= headerStart && p <= headerEnd) || (p >= footerStart && p <= footerEnd);
                        const isWindow = (p >= start && p <= forwardEnd);
                        if (!isHeader && !isWindow) {
                            try {
                                wire.cancel(req.piece, req.offset, req.length);
                            } catch (e) {}
                        }
                    }
                }
            }
        }

        // Always protect container header & index for this file
        if (torrent.critical) {
            torrent.critical(headerStart, headerEnd);
            if (fileEnd - fileStart > 6) {
                torrent.critical(footerStart, footerEnd);
            }
        }

        // Set immediate rush pieces (critical priority)
        if (torrent.critical && start <= rushEnd) {
            torrent.critical(start, rushEnd);
        }

        // Set forward buffer (priority 5)
        if (torrent.select && start <= forwardEnd) {
            torrent.select(start, forwardEnd, 5);
        }

        torrentData.lastBufferedPiece = start;

        // Wake swarm event loop immediately to dispatch new target block requests
        if (typeof torrent._update === "function") {
            torrent._update();
        }
    } catch (err) {
        // Safe catch - prevent any selection range errors
    }
}

const cp = require("child_process");

function killChildProcess(proc) {
    if (!proc || proc.killed) return;
    try {
        if (process.platform === "win32" && proc.pid) {
            cp.exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
        } else {
            proc.kill("SIGKILL");
        }
    } catch (e) {}
}

const MAX_CONCURRENT_SWARMS = 10;
const IDLE_SWARM_TIMEOUT_MS = 60 * 1000; // 60 seconds without active readers or requests

/**
 * Destroys a torrent safely, freeing RAM, chunk store, and stopping swarm activity.
 * If force === true, destroys immediately regardless of active readers or grace period.
 * If force === false, protects active streams with activeReaders > 0 or recent activity.
 */
function destroyTorrent(infoHash, force = false) {
    if (!client || !client.torrents) return false;
    const hash = (infoHash || "").toLowerCase();
    const data = torrents.get(hash);

    if (data) {
        // Protect torrents actively being read by another browser tab unless forced
        if (!force && data.activeReaders && data.activeReaders > 0) {
            return false;
        }

        // Grace period for paused/buffering tabs unless forced
        if (!force && data.lastAccessed && (Date.now() - data.lastAccessed < IDLE_SWARM_TIMEOUT_MS)) {
            return false;
        }

        if (data.activeProcs) {
            for (const proc of data.activeProcs) {
                killChildProcess(proc);
            }
            data.activeProcs.clear();
        }
        torrents.delete(hash);
    }

    const t = client.torrents ? client.torrents.find(tor => (tor.infoHash || "").toLowerCase() === hash) : null;
    if (t) {
        try {
            console.log("[TorrentManager] Removing unused torrent:", t.name || hash);
            if (typeof client.remove === "function") {
                const res = client.remove(t, { destroyStore: true });
                if (res && typeof res.catch === "function") {
                    res.catch(() => {});
                }
            }
            return true;
        } catch (e) {}
    }
    return false;
}

/**
 * Removes only the losing candidate sources of a specific discovery race,
 * leaving all other active user tabs and streams completely intact!
 */
function cleanRaceCandidates(candidateSources, winnerHash) {
    if (!client || !client.torrents || !candidateSources) return;
    const winner = (winnerHash || "").toLowerCase();

    const candidateHashes = candidateSources
        .map(s => (typeof s === "string" ? s : s.infoHash || "").toLowerCase())
        .filter(h => h && h !== winner);

    for (const hash of candidateHashes) {
        destroyTorrent(hash, false);
    }
}

/**
 * Automatically cleans any torrent that is no longer in use.
 * Evaluates all swarms and evicts those with 0 active readers whose idle timeout has elapsed.
 */
function cleanIdleTorrents(idleTimeoutMs = IDLE_SWARM_TIMEOUT_MS) {
    if (!client || !client.torrents) return;
    const now = Date.now();

    for (const t of [...client.torrents]) {
        const hash = (t.infoHash || "").toLowerCase();
        const data = torrents.get(hash);
        const readers = (data && data.activeReaders) || 0;
        const lastAccess = (data && data.lastAccessed) || 0;

        // If not being used (0 active readers) and idle timeout elapsed, remove it!
        if (readers === 0 && (now - lastAccess > idleTimeoutMs)) {
            console.log(`[TorrentManager] Idle timeout (${Math.round((now - lastAccess)/1000)}s) reached. Evicting ${t.name || hash}`);
            destroyTorrent(hash, true);
        }
    }
}

/**
 * Manages memory and bandwidth pool across concurrent browser tabs.
 * Removes any idle swarms and keeps total swarms within MAX_CONCURRENT_SWARMS.
 */
function cleanStaleTorrents() {
    if (!client || !client.torrents) return;

    // 1. First remove any torrents not being used
    cleanIdleTorrents(IDLE_SWARM_TIMEOUT_MS);

    // 2. If pool still exceeds MAX_CONCURRENT_SWARMS, evict oldest idle swarms even sooner
    if (client.torrents.length > MAX_CONCURRENT_SWARMS) {
        const idleList = [];
        for (const t of client.torrents) {
            const hash = (t.infoHash || "").toLowerCase();
            const data = torrents.get(hash);
            const readers = (data && data.activeReaders) || 0;
            const lastAccess = (data && data.lastAccessed) || 0;

            if (readers === 0) {
                idleList.push({ hash, lastAccess });
            }
        }

        idleList.sort((a, b) => a.lastAccess - b.lastAccess);

        while (client.torrents.length > MAX_CONCURRENT_SWARMS && idleList.length > 0) {
            const toEvict = idleList.shift();
            destroyTorrent(toEvict.hash, true);
        }
    }
}

/**
 * Called when a user closes a player tab, navigates away, or switches video.
 * Decrements reader count and schedules swift cleanup if no other tab is watching.
 */
function stopTorrentStream(infoHash, delayMs = 3000) {
    const hash = (infoHash || "").toLowerCase();
    const data = torrents.get(hash);
    if (!data) return;

    data.activeReaders = Math.max(0, (data.activeReaders || 1) - 1);
    data.lastAccessed = Date.now();

    if (data.activeReaders === 0) {
        setTimeout(() => {
            const current = torrents.get(hash);
            if (current && (!current.activeReaders || current.activeReaders === 0)) {
                console.log(`[TorrentManager] Stream stop requested and no active readers. Destroying ${hash}`);
                destroyTorrent(hash, true);
            }
        }, delayMs);
    }
}

// Background idle reaper running every 20 seconds
setInterval(() => {
    try {
        cleanIdleTorrents(IDLE_SWARM_TIMEOUT_MS);
    } catch (e) {
        console.error("Auto idle torrent reaper error:", e.message);
    }
}, 20000);

const path = require("path");
const { VIDEO_EXTENSIONS, TRACKERS, isAudioIncompatible, isVideoIncompatible, needsTranscoding, formatTime, buildMagnet } = require("./utils");
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
            needsTranscode: needsTranscoding(data.file.name)
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

            // Deselect whole torrent so peers focus exclusively on first playback pieces
            try { torrent.deselect(0, torrent.pieces.length - 1, 0); } catch (e) {}

            const torrentData = {
                torrent, file,
                duration: Number(duration) || 0,
                currentPiece: file._startPiece || 0,
                lastBufferedPiece: file._startPiece || 0,
                activeProcs: new Set(),
                activeReaders: 0,
                lastAccessed: Date.now(),
                isVideoIncompatible: isVideoIncompatible(file.name)
            };
            setTorrentData(infoHash, torrentData);
            prioritizeTorrentWindow(torrentData, file._startPiece || 0, 8, 40);
            if (!torrentData.duration || torrentData.duration <= 0) {
                probeTorrentDuration(torrentData).catch(() => {});
            }

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
                needsTranscode: needsTranscoding(file.name)
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
                    // Clean only losing candidates of this race; preserve all other active browser tabs
                    setTimeout(() => cleanRaceCandidates(candidates, winnerHash), 50);
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
                torrents.clear();
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
    cleanIdleTorrents,
    cleanRaceCandidates,
    destroyTorrent,
    stopTorrentStream,
    prepareTorrentOnServer,
    prepareFastest,
    cacheSource,
    getSource,
    destroyClient
};
