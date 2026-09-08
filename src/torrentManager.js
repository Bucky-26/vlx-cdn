// Store active torrents: infoHash -> { torrent, file, duration, probePromise, currentPiece, lastBufferedPiece }
const torrents = new Map();
let client = null;

async function initClient() {
    if (!client) {
        const { default: WebTorrent } = await import("webtorrent");
        client = new WebTorrent({
            maxConns: 300,
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
            console.log("Removing background torrent to maximize bandwidth:", t.name || hash);
            try {
                torrents.delete(hash);
                client.remove(t);
            } catch (e) {}
        }
    }
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
    destroyClient
};
