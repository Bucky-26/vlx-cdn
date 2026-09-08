const fs = require("fs");
const cp = require("child_process");
const path = require("path");

let cachedFfmpegPath = null;

function getFfmpegPath() {
    if (cachedFfmpegPath) return cachedFfmpegPath;

    // 1. Check environment variable override
    if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
        try {
            if (process.platform !== "win32") {
                fs.chmodSync(process.env.FFMPEG_PATH, 0o755);
            }
            cachedFfmpegPath = process.env.FFMPEG_PATH;
            return cachedFfmpegPath;
        } catch (e) {}
    }

    // 2. Check ffmpeg-static package
    try {
        const ffmpegStatic = require("ffmpeg-static");
        if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
            // Crucial for Linux / production (fixes EACCES permission denied):
            // When npm packages are deployed or extracted, the binary often loses the +x execution bit
            if (process.platform !== "win32") {
                try {
                    fs.chmodSync(ffmpegStatic, 0o755);
                } catch (chmodErr) {
                    console.warn(`Could not chmod +x ${ffmpegStatic}:`, chmodErr.message);
                }
            }

            // Verify execution access
            if (process.platform === "win32") {
                cachedFfmpegPath = ffmpegStatic;
                return cachedFfmpegPath;
            } else {
                try {
                    fs.accessSync(ffmpegStatic, fs.constants.X_OK);
                    cachedFfmpegPath = ffmpegStatic;
                    return cachedFfmpegPath;
                } catch (accessErr) {
                    console.warn(`ffmpeg-static at ${ffmpegStatic} is not executable:`, accessErr.message);
                }
            }
        }
    } catch (err) {
        console.warn("ffmpeg-static module not available:", err.message);
    }

    // 3. Fallback to system-installed ffmpeg (/usr/bin/ffmpeg, /usr/local/bin/ffmpeg, or in PATH)
    const systemPaths = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/bin/ffmpeg"];
    for (const p of systemPaths) {
        if (fs.existsSync(p)) {
            try {
                fs.accessSync(p, fs.constants.X_OK);
                cachedFfmpegPath = p;
                console.log(`Using system ffmpeg at ${p}`);
                return cachedFfmpegPath;
            } catch (e) {}
        }
    }

    // Try finding via `which` or `where`
    try {
        const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
        const found = cp.execSync(cmd, { stdio: ["pipe", "pipe", "ignore"], encoding: "utf8" }).trim().split("\n")[0].trim();
        if (found && fs.existsSync(found)) {
            cachedFfmpegPath = found;
            console.log(`Found ffmpeg in PATH: ${found}`);
            return cachedFfmpegPath;
        }
    } catch (e) {}

    // Fallback: default to standard binary command name or static path
    try {
        const ffmpegStatic = require("ffmpeg-static");
        cachedFfmpegPath = ffmpegStatic || "ffmpeg";
    } catch (e) {
        cachedFfmpegPath = "ffmpeg";
    }

    return cachedFfmpegPath;
}

module.exports = { getFfmpegPath };
