// Store active torrents: infoHash -> { torrent, file, duration, probePromise, currentPiece, lastBufferedPiece }
const torrents = new Map();
let client = null;

async function initClient() {
    if (!client) {
        const { default: WebTorrent } = await import("webtorrent");
        client = new WebTorrent({
            maxConns: 500,
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
function prioritizeTorrentWindow(torrentData, targetPiece = 0, rushCount = 15, forwardCount = 80) {
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
        // 1. Container header & trailer critical for seeking / metadata
        if (torrent.critical) {
            torrent.critical(0, Math.min(totalPieces - 1, 3));
            if (totalPieces > 6) {
                torrent.critical(totalPieces - 3, totalPieces - 1);
            }
        }

        // If jumping forward, cancel pieces before the seek point (preserving headers 0..3)
        if (targetPiece > 6 && torrent.deselect) {
            try {
                torrent.deselect(4, targetPiece - 1);
            } catch (e) {}
        }

        // 2. Immediate rush pieces (critical hotswap)
        if (torrent.critical && start <= rushEnd) {
            torrent.critical(start, rushEnd);
        }

        // 3. Generous forward buffer (priority 5)
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

async function prepareTorrentOnServer(sourceOrHash, duration = 0) {
    let source = null;
    let infoHash = "";
    let magnet = "";

    if (typeof sourceOrHash === "string") {
        infoHash = sourceOrHash.toLowerCase();
        source = getSource(infoHash);
        if (source && source.magnet) {
            magnet = source.magnet;
        }
    } else if (sourceOrHash && typeof sourceOrHash === "object") {
        source = sourceOrHash;
        infoHash = (source.infoHash || source.id || "").toLowerCase();
        magnet = source.magnet || "";
        cacheSource(infoHash, source);
    }

    if (!infoHash) {
        throw new Error("Invalid stream source");
    }

    // Automatically construct standard magnet if not explicitly cached
    if (!magnet) {
        magnet = buildMagnet(infoHash, source && source.name ? source.name : "video");
    }

    // Already active in torrents map
    if (hasTorrent(infoHash)) {
        const data = getTorrentData(infoHash);
        if (duration && (!data.duration || data.duration <= 0)) {
            data.duration = Number(duration);
        }
        return {
            id: infoHash,
            infoHash,
            filename: data.file.name,
            streamUrl: `/stream/${infoHash}`,
            transcodeUrl: `/stream/${infoHash}?transcode=audio`,
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
    if (!c) {
        throw new Error("Streaming engine is initializing");
    }

    // NOTE: cleanStaleTorrents is NOT called here so parallel racing works correctly.
    // It is called externally after a winner is determined (in prepareFastest or caller).

    const prepPromise = new Promise(async (resolve, reject) => {
        let responded = false;

        // 15s per-source timeout — when racing multiple sources this is plenty
        const timeoutTimer = setTimeout(() => {
            if (!responded) {
                responded = true;
                reject(new Error("Timeout connecting to media stream peers. Please try another server or quality."));
            }
        }, 15000);

        function onReady(torrent) {
            if (responded) return;
            responded = true;
            clearTimeout(timeoutTimer);

            const videoFiles = torrent.files.filter((f) => {
                const ext = path.extname(f.name).toLowerCase();
                return VIDEO_EXTENSIONS.includes(ext);
            });

            if (videoFiles.length === 0) {
                return reject(new Error("No playable video tracks found in this stream source."));
            }

            // Pick largest video file (most likely main feature)
            const file = videoFiles.sort((a, b) => b.length - a.length)[0];

            // Deselect ALL files first, then select only the target file
            try {
                torrent.files.forEach((f) => f.deselect());
            } catch (e) {}
            try { file.select(); } catch (e) {}

            const torrentData = {
                torrent,
                file,
                duration: Number(duration) || 0,
                currentPiece: file._startPiece || 0,
                lastBufferedPiece: file._startPiece || 0
            };
            setTorrentData(infoHash, torrentData);

            // Aggressively rush first 25 pieces + 120-piece forward buffer
            prioritizeTorrentWindow(torrentData, file._startPiece || 0, 25, 120);

            // Probe duration in background (non-blocking)
            probeTorrentDuration(torrentData).catch(() => {});

            console.log(`Server prepared stream for ${file.name} (${infoHash})`);

            resolve({
                id: infoHash,
                infoHash,
                filename: file.name,
                streamUrl: `/stream/${infoHash}`,
                transcodeUrl: `/stream/${infoHash}?transcode=audio`,
                duration: torrentData.duration || 0,
                durationFormatted: formatTime(torrentData.duration || 0),
                needsTranscode: isAudioIncompatible(file.name)
            });
        }

        try {
            const existing = await c.get(infoHash);
            if (existing) {
                if (existing.ready || (existing.files && existing.files.length > 0)) {
                    return onReady(existing);
                }
                existing.once("ready", () => onReady(existing));
                existing.once("error", (err) => {
                    if (!responded) {
                        responded = true;
                        clearTimeout(timeoutTimer);
                        reject(err);
                    }
                });
                return;
            }
        } catch (e) {}

        const torrentOpts = {
            destroyStoreOnDestroy: true,
            deselect: true,           // Don't download anything until we tell it to
            strategy: "sequential",
            maxConns: 200,             // More peers = faster metadata + first pieces
            storeCacheSlots: 200,      // Larger RAM cache = smoother buffering
            announce: TRACKERS
        };

        try {
            const torrent = c.add(magnet, torrentOpts, (t) => {
                try { t.setMaxListeners(0); } catch (e) {}
                onReady(t);
            });
            try { torrent.setMaxListeners(0); } catch (e) {}

            torrent.on("error", (err) => {
                if (!responded) {
                    responded = true;
                    clearTimeout(timeoutTimer);
                    reject(err);
                }
            });

            torrent.on("ready", () => onReady(torrent));
        } catch (err) {
            if (!responded) {
                responded = true;
                clearTimeout(timeoutTimer);
                reject(err);
            }
        }
    });

    pendingPreparations.set(infoHash, prepPromise);
    // Attach a no-op catch so Node.js doesn't throw unhandledRejection on the
    // stored reference — callers still get rejection via `return prepPromise`
    prepPromise.catch(() => {});
    prepPromise.finally(() => {
        pendingPreparations.delete(infoHash);
    });

    return prepPromise;
}

/**
 * Races ALL available sources in parallel and resolves with the first one
 * that successfully connects to peers. After the winner is found, stale
 * losing torrents are cleaned up to free bandwidth.
 */
async function prepareFastest(sources, duration = 0) {
    if (!sources || sources.length === 0) {
        throw new Error("No stream sources available");
    }

    // Start all sources simultaneously — do NOT clean stale torrents yet
    const races = sources.map((src) =>
        prepareTorrentOnServer(src, duration)
            .then((result) => ({ ok: true, result, src }))
            .catch((err) => ({ ok: false, err, src }))
    );

    return new Promise((resolve, reject) => {
        let settled = 0;
        let won = false;

        races.forEach((p) => {
            p.then((outcome) => {
                settled++;
                if (!won && outcome.ok) {
                    won = true;
                    // Clean ALL other losing torrents NOW that winner is known
                    const winnerHash = (outcome.result.infoHash || "").toLowerCase();
                    setImmediate(() => cleanStaleTorrents(winnerHash));
                    resolve(outcome.result);
                } else if (!won && settled === races.length) {
                    reject(new Error("All stream sources timed out. Please try again."));
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
