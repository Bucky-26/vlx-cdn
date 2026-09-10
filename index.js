const express = require("express");
const path = require("path");
const apiRoutes = require("./src/routes/api");
const streamRoutes = require("./src/routes/stream");
const { mediaRouter } = require("./src/routes/media");
const { initClient, destroyClient } = require("./src/torrentManager");
const { getFfmpegPath } = require("./src/ffmpegHelper");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Serve static player assets (CSS, JS) without serving index.html on root
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// Mount TMDB media endpoints: /movie/:tmdbid and /tv/:tmdbid/:season/:episode
app.use("/", mediaRouter);

// Mount API and Stream routes
app.use("/api", apiRoutes);
app.use("/stream", streamRoutes);

// Root endpoint: no torrent search page - strictly direct media streaming
app.get("/", (req, res) => {
    res.status(503).json({
        error: "Service Unavailable",
        message: "Viewlix Media Server: Please access via /movie/:tmdbid or /tv/:tmdbid/:season/:episode"
    });
});

async function start() {
    const ffmpegBin = getFfmpegPath();
    console.log(`FFmpeg binary configured: ${ffmpegBin}`);

    await initClient();

    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

// Global process error resilience - prevent server from crashing
process.on("uncaughtException", (err) => {
    console.error("Server caught uncaughtException:", err.message);
});

process.on("unhandledRejection", (reason) => {
    const msg = (reason && reason.message) || String(reason);
    // Timeout rejections from losing race sources are expected — suppress them
    if (msg.includes("Timeout connecting to media stream peers")) return;
    if (msg.includes("All stream sources timed out")) return;
    console.error("Server caught unhandledRejection:", reason);
});

process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await destroyClient();
    process.exit(0);
});

start();