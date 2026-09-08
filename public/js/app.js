let currentData = null;
let isTranscodeActive = true;
let playbackBaseTime = 0;
let totalDuration = 0;
let isSeeking = false;
let hideControlsTimer = null;
let durationPollTimer = null;

const player = document.getElementById("player");
const videoContainer = document.getElementById("videoContainer");
const spinner = document.getElementById("spinner");
const timeline = document.getElementById("timeline");
const playedBar = document.getElementById("playedBar");
const bufferedBar = document.getElementById("bufferedBar");
const scrubberThumb = document.getElementById("scrubberThumb");
const timeTooltip = document.getElementById("timeTooltip");
const currentTimeLabel = document.getElementById("currentTimeLabel");
const totalTimeLabel = document.getElementById("totalTimeLabel");
const playPauseBtn = document.getElementById("playPauseBtn");
const volBtn = document.getElementById("volBtn");
const volSlider = document.getElementById("volSlider");

let currentSearchResults = [];
let displayedResults = [];
let activeQualityFilter = "all";

function switchTab(tab) {
    const searchBtn = document.getElementById("tabSearchBtn");
    const magnetBtn = document.getElementById("tabMagnetBtn");
    const searchView = document.getElementById("searchView");
    const magnetView = document.getElementById("magnetView");

    if (tab === "search") {
        searchBtn.classList.add("active");
        magnetBtn.classList.remove("active");
        searchView.style.display = "block";
        magnetView.style.display = "none";
        document.getElementById("searchQuery").focus();
    } else {
        magnetBtn.classList.add("active");
        searchBtn.classList.remove("active");
        magnetView.style.display = "block";
        searchView.style.display = "none";
        document.getElementById("magnet").focus();
    }
}

function quickSearch(query) {
    document.getElementById("searchQuery").value = query;
    performSearch();
}

async function performSearch(e) {
    if (e) e.preventDefault();
    const query = document.getElementById("searchQuery").value.trim();
    if (!query) return;

    // If user pasted a magnet link or hash into search, stream directly!
    if (query.startsWith("magnet:?") || /^[0-9a-fA-F]{40}$/i.test(query)) {
        playTorrent(query);
        return;
    }

    const loading = document.getElementById("searchLoading");
    const resultsContainer = document.getElementById("searchResults");
    const searchSubmitBtn = document.getElementById("searchSubmitBtn");

    loading.style.display = "flex";
    resultsContainer.innerHTML = "";
    if (searchSubmitBtn) searchSubmitBtn.disabled = true;

    try {
        const res = await fetch("/api/search?q=" + encodeURIComponent(query));
        const data = await res.json();

        loading.style.display = "none";

        if (!res.ok) {
            throw new Error(data.error || "Search failed");
        }

        currentSearchResults = data.results || [];
        activeQualityFilter = "all";
        renderSearchResults(currentSearchResults, query);
    } catch (err) {
        loading.style.display = "none";
        resultsContainer.innerHTML = '<div class="no-results" style="color: #f87171;">❌ Search error: ' + escapeHtml(err.message) + '</div>';
    } finally {
        if (searchSubmitBtn) searchSubmitBtn.disabled = false;
    }
}

function setQualityFilter(filter) {
    activeQualityFilter = filter;
    document.querySelectorAll(".filter-chip").forEach(el => {
        el.classList.toggle("active", el.dataset.filter === filter);
    });

    if (filter === "all") {
        renderSearchResults(currentSearchResults, null, false);
    } else {
        const filtered = currentSearchResults.filter(item => {
            const name = item.name.toLowerCase();
            if (filter === "1080p") return name.includes("1080p");
            if (filter === "720p") return name.includes("720p");
            if (filter === "4k") return name.includes("2160p") || name.includes("4k");
            return true;
        });
        renderSearchResults(filtered, null, false);
    }
}

function renderSearchResults(items, query = null, rebindHeader = true) {
    const container = document.getElementById("searchResults");
    if (!items || items.length === 0) {
        displayedResults = [];
        container.innerHTML = '<div class="no-results">No torrents found. Try a different keyword or check spelling.</div>';
        return;
    }

    displayedResults = items;
    let html = "";
    if (rebindHeader) {
        html += '<div class="results-header">' +
            '<span>Found <strong>' + items.length + '</strong> torrents' + (query ? ' for "<em>' + escapeHtml(query) + '</em>"' : '') + ':</span>' +
            '<div class="filter-chips">' +
                '<button class="filter-chip ' + (activeQualityFilter === "all" ? "active" : "") + '" data-filter="all" onclick="setQualityFilter(this.dataset.filter)">All</button>' +
                '<button class="filter-chip ' + (activeQualityFilter === "1080p" ? "active" : "") + '" data-filter="1080p" onclick="setQualityFilter(this.dataset.filter)">1080p</button>' +
                '<button class="filter-chip ' + (activeQualityFilter === "720p" ? "active" : "") + '" data-filter="720p" onclick="setQualityFilter(this.dataset.filter)">720p</button>' +
                '<button class="filter-chip ' + (activeQualityFilter === "4k" ? "active" : "") + '" data-filter="4k" onclick="setQualityFilter(this.dataset.filter)">4K / 2160p</button>' +
            '</div>' +
        '</div>';
    }

    items.forEach((item, index) => {
        const lower = item.name.toLowerCase();
        let resBadge = "";
        if (lower.includes("2160p") || lower.includes("4k")) resBadge = '<span class="tag-res">4K</span>';
        else if (lower.includes("1080p")) resBadge = '<span class="tag-res">1080p</span>';
        else if (lower.includes("720p")) resBadge = '<span class="tag-res">720p</span>';

        html += '<div class="torrent-card">' +
            '<div class="torrent-meta">' +
                '<div class="torrent-title">' + escapeHtml(item.name) + '</div>' +
                '<div class="torrent-tags">' +
                    '<span class="tag-size">💾 ' + item.sizeFormatted + '</span>' +
                    '<span class="tag-seeds" title="Seeders">▲ ' + item.seeders.toLocaleString() + ' seeds</span>' +
                    '<span class="tag-leech" title="Leechers">▼ ' + item.leechers.toLocaleString() + ' peers</span>' +
                    resBadge +
                '</div>' +
            '</div>' +
            '<div class="torrent-actions">' +
                '<button class="btn-stream" onclick="streamSearchResult(' + index + ')">▶ Stream Now</button>' +
                '<button class="btn-secondary" title="Copy Magnet" onclick="copySearchResultMagnet(' + index + ')">📋</button>' +
            '</div>' +
        '</div>';
    });

    container.innerHTML = html;
}

function streamSearchResult(index) {
    const item = displayedResults[index];
    if (!item) return;
    const magnet = item.magnet || buildClientMagnet(item.infoHash, item.name);
    document.getElementById("magnet").value = magnet;
    playTorrent(magnet);
}

function copySearchResultMagnet(index) {
    const item = displayedResults[index];
    if (!item) return;
    const magnet = item.magnet || buildClientMagnet(item.infoHash, item.name);
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(magnet).then(() => {
            showToast("✅ Magnet link copied to clipboard!");
        }).catch(() => {
            prompt("Copy magnet link:", magnet);
        });
    } else {
        prompt("Copy magnet link:", magnet);
    }
}

function buildClientMagnet(infoHash, name) {
    const trackers = [
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.tracker.cl:1337/announce",
        "udp://9.rarbg.to:2920/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "udp://exodus.desync.com:6969/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://open.stealth.si:80/announce"
    ];
    const tr = trackers.map(t => "&tr=" + encodeURIComponent(t)).join("");
    return "magnet:?xt=urn:btih:" + infoHash + "&dn=" + encodeURIComponent(name || "video") + tr;
}

function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function playTorrent(directMagnet = null) {
    let magnet = (directMagnet || document.getElementById("magnet").value).trim();
    const status = document.getElementById("status");
    const playerSection = document.getElementById("playerSection");
    const playBtn = document.getElementById("playBtn");

    if (!magnet) {
        alert("Please enter a valid magnet link or search for a torrent above");
        return;
    }

    if (/^[0-9a-fA-F]{40}$/i.test(magnet)) {
        magnet = buildClientMagnet(magnet, "video");
    }

    status.style.display = "block";
    status.style.color = "#a5b4fc";
    status.innerText = "⏳ Connecting to torrent swarm...";
    if (playBtn) playBtn.disabled = true;

    // Scroll smoothly down to the player section
    playerSection.style.display = "block";
    playerSection.scrollIntoView({ behavior: "smooth", block: "nearest" });

    try {
        const response = await fetch("/api/torrent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ magnet })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Failed to load torrent");
        }

        currentData = data;
        totalDuration = data.duration || 0;
        isTranscodeActive = document.getElementById("fixAudio").checked;

        document.getElementById("fileTitle").innerText = "Streaming: " + data.filename;
        if (totalDuration > 0) {
            totalTimeLabel.innerText = data.durationFormatted || formatTimeDisplay(totalDuration);
        } else {
            totalTimeLabel.innerText = "--:--";
            pollDuration(data.infoHash);
        }

        loadStream();
        status.style.display = "none";
    } catch (error) {
        status.style.display = "block";
        status.style.color = "#f87171";
        status.innerText = "❌ Error: " + error.message;
    } finally {
        if (playBtn) playBtn.disabled = false;
    }
}

function pollDuration(infoHash) {
    clearInterval(durationPollTimer);
    let attempts = 0;
    durationPollTimer = setInterval(async () => {
        attempts++;
        if (attempts > 30 || totalDuration > 0) {
            clearInterval(durationPollTimer);
            return;
        }
        try {
            const res = await fetch("/api/duration/" + infoHash);
            if (res.ok) {
                const d = await res.json();
                if (d.duration && d.duration > 0) {
                    totalDuration = d.duration;
                    totalTimeLabel.innerText = d.durationFormatted || formatTimeDisplay(d.duration);
                    updateTimeDisplay(player.currentTime || 0);
                    updateBufferedBar();
                    clearInterval(durationPollTimer);
                }
            }
        } catch (e) {}
    }, 1500);
}

function loadStream() {
    if (!currentData) return;

    showSpinner(true);

    const audioLabel = document.getElementById("audioModeLabel");
    const toggleBtn = document.getElementById("toggleAudioBtn");

    if (isTranscodeActive) {
        player.src = currentData.transcodeUrl;
        audioLabel.innerHTML = "🔊 Audio: AAC Stereo (Browser Compatible)";
        audioLabel.style.color = "#34d399";
        toggleBtn.innerText = "Switch to Direct Stream (Original Audio)";
    } else {
        player.src = currentData.streamUrl;
        audioLabel.innerHTML = "⚠️ Audio: Original Stream (Browser may not decode DDP/AC3)";
        audioLabel.style.color = "#fbbf24";
        toggleBtn.innerText = "Switch to Fixed Audio (AAC Transcode)";
    }

    player.load();
    player.play().catch(e => console.log("Play notice:", e));
    updateTimeDisplay(0);
}

let toastTimer = null;
function showToast(msg) {
    const t = document.getElementById("toastMsg");
    if (!t) return;
    t.innerText = msg;
    t.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        t.classList.remove("visible");
    }, 3500);
}

function seekTo(targetTime) {
    if (targetTime < 0) targetTime = 0;
    if (totalDuration > 0 && targetTime > totalDuration) targetTime = totalDuration;

    if (!isTranscodeActive) {
        player.currentTime = targetTime;
        updateTimeDisplay(targetTime);
        return;
    }

    let maxBuffered = 0;
    try {
        for (let i = 0; i < player.buffered.length; i++) {
            if (player.buffered.end(i) > maxBuffered) maxBuffered = player.buffered.end(i);
        }
    } catch (e) {}

    if (targetTime <= maxBuffered) {
        player.currentTime = targetTime;
        updateTimeDisplay(targetTime);
    } else {
        showToast("Torrent is downloading sequentially. Currently buffered up to " + formatTimeDisplay(maxBuffered) + ". (For instant remote seeking, use Copy VLC Link below).");
    }
}

function skip(deltaSeconds) {
    const current = player.currentTime || 0;
    seekTo(current + deltaSeconds);
}

function updateBufferedBar() {
    const durationToUse = totalDuration > 0 ? totalDuration : (!isTranscodeActive && player.duration && isFinite(player.duration) ? player.duration : 0);
    if (!durationToUse || durationToUse <= 0 || !player.buffered || player.buffered.length === 0) {
        bufferedBar.style.width = "0%";
        return;
    }
    try {
        let maxBuf = 0;
        for (let i = 0; i < player.buffered.length; i++) {
            if (player.buffered.end(i) > maxBuf) maxBuf = player.buffered.end(i);
        }
        const pct = Math.min(100, Math.max(0, (maxBuf / durationToUse) * 100));
        bufferedBar.style.width = pct + "%";
    } catch (e) {}
}

function updateTimeDisplay(absTime) {
    currentTimeLabel.innerText = formatTimeDisplay(absTime);

    const durationToUse = totalDuration > 0 ? totalDuration : (!isTranscodeActive && player.duration && isFinite(player.duration) ? player.duration : 0);

    if (durationToUse > 0) {
        totalTimeLabel.innerText = formatTimeDisplay(durationToUse);
        const pct = Math.min(100, Math.max(0, (absTime / durationToUse) * 100));
        playedBar.style.width = pct + "%";
        scrubberThumb.style.left = pct + "%";
    } else {
        totalTimeLabel.innerText = "--:--";
        playedBar.style.width = "0%";
        scrubberThumb.style.left = "0%";
    }
}

function formatTimeDisplay(sec) {
    if (!sec || isNaN(sec) || sec < 0) return "00:00";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const pad = (n) => (n < 10 ? "0" : "") + n;
    if (h > 0) return h + ":" + pad(m) + ":" + pad(s);
    return pad(m) + ":" + pad(s);
}

// Player Event Listeners
player.addEventListener("timeupdate", () => {
    if (isSeeking) return;
    updateTimeDisplay(player.currentTime || 0);
    updateBufferedBar();
});

player.addEventListener("progress", updateBufferedBar);

player.addEventListener("playing", () => {
    showSpinner(false);
    playPauseBtn.innerText = "⏸";
});

player.addEventListener("pause", () => {
    playPauseBtn.innerText = "▶";
});

player.addEventListener("waiting", () => {
    showSpinner(true);
});

player.addEventListener("canplay", () => {
    showSpinner(false);
});

function showSpinner(show) {
    spinner.style.display = show ? "flex" : "none";
}

function togglePlayPause() {
    if (player.paused) {
        player.play();
    } else {
        player.pause();
    }
}

player.addEventListener("click", togglePlayPause);

// Timeline Scrubbing
let isDragging = false;

function getTimelineTimeFromEvent(e) {
    const rect = timeline.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = x / rect.width;
    const durationToUse = totalDuration > 0 ? totalDuration : (!isTranscodeActive && player.duration && isFinite(player.duration) ? player.duration : 0);
    return ratio * durationToUse;
}

timeline.addEventListener("mousemove", (e) => {
    const rect = timeline.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = x / rect.width;
    const durationToUse = totalDuration > 0 ? totalDuration : (!isTranscodeActive && player.duration && isFinite(player.duration) ? player.duration : 0);
    if (durationToUse <= 0) {
        timeTooltip.style.display = "none";
        return;
    }
    const hoverTime = ratio * durationToUse;

    timeTooltip.style.display = "block";
    timeTooltip.style.left = x + "px";
    timeTooltip.innerText = formatTimeDisplay(hoverTime);

    if (isDragging) {
        playedBar.style.width = (ratio * 100) + "%";
        scrubberThumb.style.left = (ratio * 100) + "%";
        currentTimeLabel.innerText = formatTimeDisplay(hoverTime);
    }
});

timeline.addEventListener("mouseleave", () => {
    timeTooltip.style.display = "none";
});

timeline.addEventListener("mousedown", (e) => {
    isDragging = true;
    isSeeking = true;
    const targetTime = getTimelineTimeFromEvent(e);
    updateTimeDisplay(targetTime);

    const onMouseUp = (upEvent) => {
        isDragging = false;
        isSeeking = false;
        const finalTime = getTimelineTimeFromEvent(upEvent);
        seekTo(finalTime);
        window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mouseup", onMouseUp);
});

// Volume Controls
function toggleMute() {
    player.muted = !player.muted;
    volBtn.innerText = player.muted ? "🔇" : (player.volume > 0.5 ? "🔊" : "🔉");
}

function changeVolume(val) {
    player.volume = parseFloat(val);
    player.muted = player.volume === 0;
    volBtn.innerText = player.muted ? "🔇" : (player.volume > 0.5 ? "🔊" : "🔉");
}

// Fullscreen
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        videoContainer.requestFullscreen().catch(err => alert(err.message));
    } else {
        document.exitFullscreen();
    }
}

// Auto-hide controls
function resetControlsTimeout() {
    videoContainer.classList.remove("hide-controls");
    clearTimeout(hideControlsTimer);
    if (!player.paused) {
        hideControlsTimer = setTimeout(() => {
            videoContainer.classList.add("hide-controls");
        }, 2800);
    }
}

videoContainer.addEventListener("mousemove", resetControlsTimeout);
videoContainer.addEventListener("mouseleave", () => {
    if (!player.paused) videoContainer.classList.add("hide-controls");
});

// Keyboard Shortcuts
window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;

    if (e.code === "Space" || e.code === "KeyK") {
        e.preventDefault();
        togglePlayPause();
    } else if (e.code === "ArrowLeft" || e.code === "KeyJ") {
        e.preventDefault();
        skip(-10);
    } else if (e.code === "ArrowRight" || e.code === "KeyL") {
        e.preventDefault();
        skip(10);
    } else if (e.code === "KeyF") {
        e.preventDefault();
        toggleFullscreen();
    } else if (e.code === "KeyM") {
        e.preventDefault();
        toggleMute();
    }
});

function toggleAudioMode() {
    isTranscodeActive = !isTranscodeActive;
    document.getElementById("fixAudio").checked = isTranscodeActive;
    loadStream();
}

function copyVlcUrl() {
    if (!currentData) return;
    const fullUrl = window.location.origin + currentData.streamUrl;
    navigator.clipboard.writeText(fullUrl).then(() => {
        const btn = document.getElementById("copyVlcBtn");
        const orig = btn.innerText;
        btn.innerText = "✅ Copied!";
        setTimeout(() => btn.innerText = orig, 2000);
    });
}

let currentMediaTorrents = [];

function switchSource(index) {
    const torrent = currentMediaTorrents[index];
    if (!torrent) return;

    const badge = document.getElementById("currentSourceBadge");
    if (badge) {
        badge.innerText = (index === 0 ? "⚡ Best Match" : `Server ${parseInt(index, 10) + 1}`) + ` (${torrent.seeders} seeds)`;
    }

    showToast(`Switching to: ${torrent.name.slice(0, 45)}...`);
    playTorrent(torrent.magnet);
}

function renderMediaBanner(data) {
    const banner = document.getElementById("mediaBanner");
    if (!banner) return;

    const isMovie = data.mediaType === "movie";
    const tmdb = data.tmdb;
    const title = isMovie ? tmdb.title : tmdb.showName;
    const subTitle = isMovie
        ? (tmdb.year ? `(${tmdb.year})` : "")
        : `Season ${tmdb.season}, Episode ${tmdb.episode}: "${tmdb.episodeTitle}"`;

    const posterUrl = tmdb.poster || tmdb.still || "";
    const backdropUrl = tmdb.backdrop || "";
    const rating = tmdb.voteAverage ? `⭐ ${tmdb.voteAverage}` : "";
    const genres = (tmdb.genres || []).map(g => `<span class="badge genre-badge">${escapeHtml(g)}</span>`).join(" ");

    currentMediaTorrents = data.torrents || [];

    // Build options for source selector
    let sourceOptionsHtml = "";
    currentMediaTorrents.forEach((t, i) => {
        const isBest = i === 0 ? " [⚡ Best Result]" : "";
        const label = `Server ${i + 1}${isBest}: ${t.name} (${t.seeders} seeds • ${t.sizeFormatted})`;
        sourceOptionsHtml += `<option value="${i}">${escapeHtml(label)}</option>`;
    });

    banner.style.display = "block";
    if (backdropUrl) {
        banner.style.backgroundImage = `linear-gradient(to right, rgba(11, 15, 23, 0.96) 25%, rgba(11, 15, 23, 0.85) 100%), url('${backdropUrl}')`;
        banner.style.backgroundSize = "cover";
        banner.style.backgroundPosition = "center";
    } else {
        banner.style.backgroundImage = "none";
    }

    banner.innerHTML = `
        <div class="media-banner-content">
            ${posterUrl ? `<img src="${posterUrl}" alt="${escapeHtml(title)}" class="media-poster">` : ""}
            <div class="media-meta">
                <div class="media-header">
                    <h2 class="media-title">${escapeHtml(title)} <span class="media-subtitle">${escapeHtml(subTitle)}</span></h2>
                    <div class="media-badges" style="margin-top: 6px;">
                        ${rating ? `<span class="badge rating-badge">${rating}</span>` : ""}
                        ${isMovie && tmdb.runtime ? `<span class="badge">${tmdb.runtime} min</span>` : ""}
                        ${genres}
                        <span class="badge stream-count-badge">🎬 ${data.totalTorrents} available streams</span>
                    </div>
                </div>
                ${tmdb.overview ? `<p class="media-overview">${escapeHtml(tmdb.overview)}</p>` : ""}

                ${currentMediaTorrents.length > 0 ? `
                <div class="source-selector-bar">
                    <div class="source-label">
                        <span>⚡ Stream Source:</span>
                        <span class="source-badge" id="currentSourceBadge">⚡ Best Match (${currentMediaTorrents[0].seeders} seeds)</span>
                    </div>
                    <div class="source-select-wrap">
                        <select id="sourceSelect" class="source-select" onchange="switchSource(this.value)">
                            ${sourceOptionsHtml}
                        </select>
                    </div>
                </div>
                ` : ""}
            </div>
        </div>
    `;
}

async function checkTmdbRoute() {
    const path = window.location.pathname;
    const movieMatch = path.match(/^\/movie\/([0-9]+)/i);
    const tvMatch = path.match(/^\/tv\/([0-9]+)\/([0-9]+)(?:\/(?:epesode\/)?([0-9]+))?/i);

    let apiUrl = null;
    if (movieMatch) {
        apiUrl = `/api/movie/${movieMatch[1]}`;
    } else if (tvMatch) {
        const tmdbId = tvMatch[1];
        const season = tvMatch[2];
        const episode = tvMatch[3] || 1;
        apiUrl = `/api/tv/${tmdbId}/${season}/${episode}`;
    }

    if (!apiUrl) return;

    // Switch to pure player-mode
    document.body.classList.add("player-mode");
    const playerSection = document.getElementById("playerSection");
    if (playerSection) playerSection.style.display = "block";

    const banner = document.getElementById("mediaBanner");
    if (banner) {
        banner.style.display = "block";
        banner.innerHTML = `
            <div class="media-loading">
                <div class="mini-spinner"></div>
                <span>Analyzing streams and selecting the best quality torrent...</span>
            </div>
        `;
    }

    try {
        const res = await fetch(apiUrl);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load media info");

        renderMediaBanner(data);

        // Auto-play the best result selected by the algorithm!
        const best = data.bestTorrent || (data.torrents && data.torrents[0]);
        if (best && best.magnet) {
            playTorrent(best.magnet);
        } else {
            showToast("No active torrent seeds found for this title.");
        }
    } catch (err) {
        if (banner) {
            banner.innerHTML = `<div class="no-results" style="color: #f87171;">❌ ${escapeHtml(err.message)}</div>`;
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    checkTmdbRoute();
});
checkTmdbRoute();


