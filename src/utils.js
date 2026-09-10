const path = require("path");

const TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://explodie.org:6969/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://p4p.arenabg.com:1337/announce",
    "udp://movies.zsw.ca:6969/announce",
    "udp://tracker.moeking.me:6969/announce",
    "udp://9.rarbg.to:2920/announce",
    "wss://tracker.openwebtorrent.com"
];

const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v"];

function isVideoIncompatible(filename) {
    if (!filename) return false;
    const lower = filename.toLowerCase();
    const ext = path.extname(lower);
    if (ext === ".avi" || ext === ".wmv" || ext === ".flv" || ext === ".vob") {
        return true;
    }
    return (
        lower.includes("x265") ||
        lower.includes("hevc") ||
        lower.includes("h.265") ||
        lower.includes("h265") ||
        lower.includes("10bit") ||
        lower.includes("10-bit") ||
        lower.includes("hi10p") ||
        lower.includes("2160p") ||
        lower.includes("4k") ||
        lower.includes("uhd") ||
        lower.includes("hdr") ||
        lower.includes("hdr10") ||
        lower.includes("dolby.vision") ||
        lower.includes("dolbyvision") ||
        lower.includes("dovi") ||
        /(?:[._-]dv[._-])/i.test(lower) ||
        lower.includes("remux") ||
        lower.includes("av1") ||
        lower.includes("vp9") ||
        lower.includes("divx") ||
        lower.includes("xvid") ||
        lower.includes("vc-1") ||
        lower.includes("vc1")
    );
}

function isAudioIncompatible(filename) {
    if (!filename) return false;
    const lower = filename.toLowerCase();
    const ext = path.extname(lower);
    if (ext === ".mkv" || ext === ".avi" || ext === ".mov" || ext === ".wmv" || ext === ".flv") return true;

    // AAC and MP3 are universally supported in all modern web browsers (including AAC 5.1 / 7.1)
    if (lower.includes("aac") || lower.includes("mp3")) {
        const hasTrueIncompatible = (
            lower.includes("ddp") ||
            lower.includes("eac3") ||
            lower.includes("e-ac-3") ||
            lower.includes("ac3") ||
            lower.includes("ac-3") ||
            lower.includes("dts") ||
            lower.includes("atmos") ||
            lower.includes("truehd")
        );
        if (!hasTrueIncompatible) return false;
    }

    return (
        lower.includes("ddp") ||
        lower.includes("eac3") ||
        lower.includes("e-ac-3") ||
        lower.includes("ac3") ||
        lower.includes("ac-3") ||
        lower.includes("dts") ||
        lower.includes("atmos") ||
        lower.includes("truehd")
    );
}

function needsTranscoding(filename) {
    return isVideoIncompatible(filename) || isAudioIncompatible(filename);
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
    isVideoIncompatible,
    isAudioIncompatible,
    needsTranscoding,
    formatTime,
    formatBytes,
    buildMagnet,
    getMimeType
};

