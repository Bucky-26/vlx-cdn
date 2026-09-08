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
app.use(express.static(path.join(__dirname, "public")));

// Mount TMDB media endpoints: /movie/:tmdbid and /tv/:tmdbid/:season/:episode
app.use("/", mediaRouter);

// Mount API and Stream routes
app.use("/api", apiRoutes);
app.use("/stream", streamRoutes);

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
    console.error("Server caught unhandledRejection:", reason);
});

process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await destroyClient();
    process.exit(0);
});

start();