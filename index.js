const express = require("express");
const path = require("path");
const cors = require("cors");
const apiRoutes = require("./src/routes/api");
const streamRoutes = require("./src/routes/stream");
const adminRoutes = require("./src/routes/admin");
const { mediaRouter } = require("./src/routes/media");
const { initClient, destroyClient } = require("./src/torrentManager");
const { getFfmpegPath } = require("./src/ffmpegHelper");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
const fs = require("fs");
const clientDistPath = path.join(__dirname, "client", "dist");
const clientDistIndex = path.join(clientDistPath, "index.html");

// Serve compiled React frontend assets if built (without auto-serving index.html on /)
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath, { index: false }));
}

// Serve static player assets (CSS, JS) from public
app.use(express.static(path.join(__dirname, "public"), { index: false }));

// Mount TMDB media endpoints: /movie/:tmdbid and /tv/:tmdbid/:season/:episode
app.use("/", mediaRouter);

// Mount API, Stream and Admin routes
app.use("/api/admin", adminRoutes);
app.use("/api", apiRoutes);
app.use("/stream", streamRoutes);

// Admin client routes
app.get(/^\/admin(\/.*)?$/, (req, res) => {
  if (fs.existsSync(clientDistIndex)) {
    return res.sendFile(clientDistIndex);
  }
  console.warn(`[Admin] Frontend build missing at ${clientDistIndex}. Run "npm run build" to build client assets.`);
  return res.status(404).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Admin Client Build Required</title>
      <style>
        body { background: #09090c; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        .card { background: rgba(18, 18, 24, 0.95); border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; padding: 36px 32px; text-align: center; max-width: 480px; box-shadow: 0 20px 40px rgba(0,0,0,0.8); }
        h1 { font-size: 1.35rem; margin-bottom: 10px; color: #ffffff; }
        p { color: #94a3b8; font-size: 0.88rem; line-height: 1.55; margin-bottom: 20px; }
        pre { background: rgba(0,0,0,0.5); color: #4ade80; padding: 12px 16px; border-radius: 8px; font-family: monospace; font-size: 0.86rem; text-align: left; overflow-x: auto; margin-bottom: 18px; border: 1px solid rgba(255,255,255,0.08); }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Admin Client Build Required</h1>
        <p>The compiled React assets in <code>client/dist</code> are missing on this production server. To fix this, run:</p>
        <pre>npm run build</pre>
        <p style="font-size: 0.78rem; color: #64748b; margin-bottom: 0;">Or commit and push the pre-compiled <code>client/dist</code> directory to your git repository.</p>
      </div>
    </body>
    </html>
  `);
});

// Root / endpoint: direct embed player only (no public catalog)
app.get("/", (req, res) => {
  return res.status(404).send();
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