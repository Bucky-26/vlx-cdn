const cp = require("child_process");
const { getFfmpegPath } = require("./ffmpegHelper");
const { formatTime } = require("./utils");

function probeTorrentDuration(torrentData) {
    if (torrentData.duration && torrentData.duration > 0) {
        return Promise.resolve(torrentData.duration);
    }
    if (torrentData.probePromise) {
        return torrentData.probePromise;
    }

    torrentData.probePromise = new Promise((resolve) => {
        let resolved = false;
        const done = (sec) => {
            if (!resolved) {
                resolved = true;
                if (sec > 0) {
                    torrentData.duration = sec;
                    console.log(`Discovered duration for ${torrentData.file.name}: ${formatTime(sec)}`);
                }
                resolve(torrentData.duration || 0);
            }
        };

        const timer = setTimeout(() => done(0), 15000);

        try {
            // Read first 3MB directly from WebTorrent stream to capture MKV/MP4 headers
            const stream = torrentData.file.createReadStream({ start: 0, end: 3000000 });
            const proc = cp.spawn(getFfmpegPath(), ["-i", "pipe:0"]);

            proc.on("error", (err) => {
                console.warn("FFmpeg probe process error:", err.message);
                clearTimeout(timer);
                try { stream.destroy(); } catch (e) {}
                done(0);
            });

            proc.stderr.on("data", (d) => {
                if (resolved) return;
                const match = d.toString().match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
                if (match) {
                    const sec = parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseFloat(match[3]);
                    clearTimeout(timer);
                    try { proc.kill(); } catch (e) {}
                    try { stream.destroy(); } catch (e) {}
                    done(sec);
                }
            });

            proc.on("close", () => {
                clearTimeout(timer);
                done(0);
            });

            stream.pipe(proc.stdin);
            stream.on("error", () => done(0));
            proc.stdin.on("error", () => {});
        } catch (e) {
            done(0);
        }
    });

    return torrentData.probePromise;
}

module.exports = { probeTorrentDuration };
