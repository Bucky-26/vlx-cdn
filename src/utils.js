const path = require("path");

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.bittor.pw:1337/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://opentracker.i2p.rocks:6969/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://9.rarbg.to:2920/announce",
    "udp://explodie.org:6969/announce",
    "udp://bt.cl.sgjp.net:6969/announce",
    "udp://tracker.zerobytes.to:1337/announce",
    "wss://tracker.openwebtorrent.com",
    "wss://tracker.btorrent.xyz"
];

const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v"];

function isAudioIncompatible(filename) {
    const lower = filename.toLowerCase();
    const ext = path.extname(lower);
    if (ext === ".mkv" || ext === ".avi" || ext === ".mov") return true;
    return (
        lower.includes("ddp") ||
        lower.includes("eac3") ||
        lower.includes("ac3") ||
        lower.includes("dts") ||
        lower.includes("atmos") ||
        lower.includes("truehd") ||
        lower.includes("5.1") ||
        lower.includes("7.1")
    );
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds) || seconds < 0) return "00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const pad = (n) => (n < 10 ? "0" : "") + n;
    if (h > 0) {
        return `${h}:${pad(m)}:${pad(s)}`;
    }
    return `${pad(m)}:${pad(s)}`;
}

function formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function buildMagnet(infoHash, name) {
    const tr = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name || "video")}${tr}`;
}

function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();

    const types = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo",
        ".mov": "video/quicktime",
        ".m4v": "video/x-m4v"
    };

    return types[ext] || "application/octet-stream";
}

module.exports = {
    TRACKERS,
    VIDEO_EXTENSIONS,
    isAudioIncompatible,
    formatTime,
    formatBytes,
    buildMagnet,
    getMimeType
};
