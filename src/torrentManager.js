// Store active torrents: infoHash -> { torrent, file, duration, probePromise }
const torrents = new Map();
let client = null;

async function initClient() {
    if (!client) {
        const { default: WebTorrent } = await import("webtorrent");
        client = new WebTorrent({
            maxConns: 200,
            dht: true,
            webSeeds: true
        });

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
    destroyClient
};
