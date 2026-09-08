let currentMedia = null;
let currentTorrents = [];
let activeTorrent = null;
let currentStreamData = null;
let isAudioTranscode = false;
let streamTimeOffset = 0;
let totalDuration = 0;
let hasProbedDuration = false;
let isDragging = false;
let isSeeking = false;
let durationPollTimer = null;
let controlsTimeout = null;
let resumeStorageKey = "";

const video = document.getElementById("player");
const playerRoot = document.getElementById("playerRoot");
const spinner = document.getElementById("spinner");
const spinnerText = document.getElementById("spinnerText");
const centerAction = document.getElementById("centerAction");
const unmutePill = document.getElementById("unmutePill");
const resumePill = document.getElementById("resumePill");
const resumeText = document.getElementById("resumeText");
const timeline = document.getElementById("timeline");
const playedBar = document.getElementById("playedBar");
const bufferedBar = document.getElementById("bufferedBar");
const scrubberThumb = document.getElementById("scrubberThumb");
const timeTooltip = document.getElementById("timeTooltip");
const timeStamp = document.getElementById("timeStamp");
const playPauseBtn = document.getElementById("playPauseBtn");
const playIcon = document.getElementById("playIcon");
const pauseIcon = document.getElementById("pauseIcon");
const volBtn = document.getElementById("volBtn");
const volSlider = document.getElementById("volSlider");
const settingsBtn = document.getElementById("settingsBtn");
const settingsMenu = document.getElementById("settingsMenu");
const serverSelect = document.getElementById("serverSelect");
const audioFixSwitch = document.getElementById("audioFixSwitch");
const toastNotice = document.getElementById("toastNotice");

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

function showToast(text, duration = 2500) {
    if (!toastNotice) return;
    toastNotice.innerText = text;
    toastNotice.classList.add("visible");
    setTimeout(() => toastNotice.classList.remove("visible"), duration);
}

function showCenterIcon(isPlay) {
    if (!centerAction) return;
    centerAction.innerText = isPlay ? "▶" : "❚❚";
    centerAction.classList.add("animate");
    setTimeout(() => centerAction.classList.remove("animate"), 350);
}

/* Idle Controls Hiding */
function resetControlsTimer() {
    playerRoot.classList.remove("hide-controls");
    clearTimeout(controlsTimeout);
    if (!video.paused) {
        controlsTimeout = setTimeout(() => {
            if (!settingsMenu.classList.contains("open") && !isDragging) {
                playerRoot.classList.add("hide-controls");
            }
        }, 2800);
    }
}

playerRoot.addEventListener("mousemove", resetControlsTimer);
playerRoot.addEventListener("click", resetControlsTimer);

/* Video Play / Pause */
function togglePlay() {
    if (video.paused) {
        video.play().catch(() => {});
        showCenterIcon(true);
    } else {
        video.pause();
        showCenterIcon(false);
    }
}

video.addEventListener("play", () => {
    playIcon.style.display = "none";
    pauseIcon.style.display = "block";
    resetControlsTimer();
});

video.addEventListener("pause", () => {
    playIcon.style.display = "block";
    pauseIcon.style.display = "none";
    playerRoot.classList.remove("hide-controls");
});

video.addEventListener("waiting", () => {
    spinner.style.display = "flex";
    spinnerText.innerText = "Buffering stream...";
});

video.addEventListener("playing", () => {
    spinner.style.display = "none";
});

/* Duration & Progress Calculations */
function pollDuration(infoHash) {
    clearInterval(durationPollTimer);
    let attempts = 0;
    durationPollTimer = setInterval(async () => {
        attempts++;
        if (attempts > 50 || hasProbedDuration) {
            clearInterval(durationPollTimer);
            return;
        }
        try {
            const res = await fetch("/api/duration/" + infoHash);
            if (res.ok) {
                const d = await res.json();
                if (d.duration && d.duration > 0) {
                    totalDuration = d.duration;
                    hasProbedDuration = true;
                    updateProgressUI();
                    updateBufferedBar();
                    clearInterval(durationPollTimer);
                }
            }
        } catch (e) {}
    }, 1500);
}

function getEffectiveDuration() {
    if (totalDuration > 0) return totalDuration;
    if (video.duration && isFinite(video.duration) && video.duration > 0) return video.duration;
    return 0;
}

function getDisplayCurrentTime() {
    if (isAudioTranscode) {
        return streamTimeOffset + (video.currentTime || 0);
    }
    return video.currentTime || 0;
}

function updateProgressUI(customTime = null) {
    const current = customTime !== null ? customTime : getDisplayCurrentTime();
    const dur = getEffectiveDuration();

    if (dur > 0) {
        const pct = Math.min(100, Math.max(0, (current / dur) * 100));
        playedBar.style.width = pct + "%";
        scrubberThumb.style.left = pct + "%";
        timeStamp.innerText = `${formatTime(current)} / ${formatTime(dur)}`;
    } else {
        playedBar.style.width = "0%";
        scrubberThumb.style.left = "0%";
        timeStamp.innerText = `${formatTime(current)} / --:--`;
    }
}

function updateBufferedBar() {
    const dur = getEffectiveDuration();
    if (dur > 0 && video.buffered && video.buffered.length > 0) {
        try {
            let maxBuf = 0;
            for (let i = 0; i < video.buffered.length; i++) {
                if (video.buffered.end(i) > maxBuf) maxBuf = video.buffered.end(i);
            }
            const effectiveBuf = isAudioTranscode ? (streamTimeOffset + maxBuf) : maxBuf;
            const pct = Math.min(100, Math.max(0, (effectiveBuf / dur) * 100));
            bufferedBar.style.width = pct + "%";
        } catch (e) {}
    }
}

video.addEventListener("progress", updateBufferedBar);

video.addEventListener("timeupdate", () => {
    if (isSeeking || isDragging) return;
    updateProgressUI();
    updateBufferedBar();

    const current = getDisplayCurrentTime();
    const dur = getEffectiveDuration();
    if (resumeStorageKey && current > 5 && dur > 30 && current < dur - 30) {
        localStorage.setItem(resumeStorageKey, Math.floor(current));
    }
});

video.addEventListener("loadedmetadata", () => {
    if (isFinite(video.duration) && video.duration > 0 && !hasProbedDuration) {
        totalDuration = video.duration;
    }
    updateProgressUI();
    updateBufferedBar();
});

video.addEventListener("durationchange", () => {
    if (isFinite(video.duration) && video.duration > 0 && !hasProbedDuration) {
        totalDuration = video.duration;
    }
    updateProgressUI();
    updateBufferedBar();
});

/* Pointer Scrubbing & Seeking */
function getTimelineTimeFromEvent(e) {
    const rect = timeline.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = rect.width > 0 ? (x / rect.width) : 0;
    const dur = getEffectiveDuration();
    return { ratio, time: ratio * dur, x };
}

function seekTo(targetTime) {
    const dur = getEffectiveDuration();
    const bounded = Math.max(0, Math.min(dur || Infinity, targetTime));

    if (isAudioTranscode) {
        // Transcoded stream: request new stream offset via &t=...
        streamTimeOffset = Math.floor(bounded);
        updateProgressUI(bounded);
        spinner.style.display = "flex";
        spinnerText.innerText = `Seeking to ${formatTime(bounded)}...`;

        const base = currentStreamData ? currentStreamData.transcodeUrl : `/stream/${activeTorrent.infoHash}?transcode=audio`;
        video.src = `${base}&t=${streamTimeOffset}`;
        video.currentTime = 0;
        video.play().catch(() => {});
    } else {
        // Direct stream: native HTML5 range seek
        video.currentTime = bounded;
        updateProgressUI(bounded);
        updateBufferedBar();
        spinner.style.display = "flex";
        spinnerText.innerText = `Fast-forwarding to ${formatTime(bounded)}...`;
    }
}

video.addEventListener("seeking", () => {
    spinner.style.display = "flex";
    const current = getDisplayCurrentTime();
    spinnerText.innerText = `Buffering at ${formatTime(current)}...`;
});

video.addEventListener("seeked", () => {
    spinner.style.display = "none";
});

video.addEventListener("canplay", () => {
    spinner.style.display = "none";
});

timeline.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    isSeeking = true;
    timeline.classList.add("dragging");
    try { timeline.setPointerCapture(e.pointerId); } catch (err) {}

    const { ratio, time } = getTimelineTimeFromEvent(e);
    playedBar.style.width = (ratio * 100) + "%";
    scrubberThumb.style.left = (ratio * 100) + "%";
    updateProgressUI(time);

    timeTooltip.style.display = "block";
    const tipX = Math.max(24, Math.min(timeline.clientWidth - 24, ratio * timeline.clientWidth));
    timeTooltip.style.left = tipX + "px";
    timeTooltip.innerText = formatTime(time);
});

timeline.addEventListener("pointermove", (e) => {
    const { ratio, time } = getTimelineTimeFromEvent(e);
    const tipX = Math.max(24, Math.min(timeline.clientWidth - 24, ratio * timeline.clientWidth));
    timeTooltip.style.left = tipX + "px";
    timeTooltip.innerText = formatTime(time);

    if (isDragging) {
        playedBar.style.width = (ratio * 100) + "%";
        scrubberThumb.style.left = (ratio * 100) + "%";
        updateProgressUI(time);
    } else {
        const dur = getEffectiveDuration();
        if (dur > 0) {
            timeTooltip.style.display = "block";
        }
    }
});

function handlePointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    isSeeking = false;
    timeline.classList.remove("dragging");
    try { timeline.releasePointerCapture(e.pointerId); } catch (err) {}

    const { time: finalTime } = getTimelineTimeFromEvent(e);
    seekTo(finalTime);
}

timeline.addEventListener("pointerup", handlePointerUp);
timeline.addEventListener("pointercancel", handlePointerUp);

timeline.addEventListener("pointerleave", () => {
    if (!isDragging) {
        timeTooltip.style.display = "none";
    }
});

let seekDebounceTimer = null;
function debouncedSeek(targetTime) {
    clearTimeout(seekDebounceTimer);
    updateProgressUI(targetTime);
    spinner.style.display = "flex";
    spinnerText.innerText = `Fast-forwarding to ${formatTime(targetTime)}...`;

    seekDebounceTimer = setTimeout(() => {
        seekTo(targetTime);
    }, 120);
}

function skip(seconds) {
    const current = getDisplayCurrentTime();
    debouncedSeek(current + seconds);
    showToast(seconds > 0 ? `+${seconds}s` : `${seconds}s`);
}

/* Volume Control */
function updateVolume(val) {
    video.volume = parseFloat(val);
    video.muted = video.volume === 0;
    volSlider.value = video.volume;
    if (video.muted) {
        document.getElementById("volHighIcon").style.display = "none";
        document.getElementById("volMuteIcon").style.display = "block";
    } else {
        document.getElementById("volHighIcon").style.display = "block";
        document.getElementById("volMuteIcon").style.display = "none";
    }
}

function toggleMute() {
    if (video.muted) {
        video.muted = false;
        if (video.volume === 0) video.volume = 0.8;
        updateVolume(video.volume);
    } else {
        video.muted = true;
        updateVolume(0);
    }
}

/* Unmute Pill Click */
function handleUnmuteClick() {
    video.muted = false;
    video.volume = 1;
    updateVolume(1);
    unmutePill.style.display = "none";
    showToast("🔊 Audio unmuted");
}

/* Resume Pill Actions */
function startOver() {
    seekTo(0);
    resumePill.style.display = "none";
    if (resumeStorageKey) localStorage.removeItem(resumeStorageKey);
    showToast("⏪ Restarting from beginning");
}

function closeResumePill() {
    resumePill.style.display = "none";
}

/* Fullscreen & PiP */
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        playerRoot.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen().catch(() => {});
    }
}

function togglePip() {
    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
    } else if (video.requestPictureInPicture) {
        video.requestPictureInPicture().catch(() => {});
    }
}

/* Settings Menu */
function toggleSettings() {
    settingsMenu.classList.toggle("open");
}

document.addEventListener("click", (e) => {
    if (settingsMenu.classList.contains("open") && !settingsMenu.contains(e.target) && !settingsBtn.contains(e.target)) {
        settingsMenu.classList.remove("open");
    }
});

function toggleAudioTranscode() {
    const prevTime = getDisplayCurrentTime();
    isAudioTranscode = audioFixSwitch.checked;
    showToast(isAudioTranscode ? "🔊 Stereo AAC transcode enabled" : "⚡ Direct stream enabled");
    if (currentStreamData) {
        seekTo(prevTime);
    }
}

/* Stream Loading */
function loadVideoStream(startTime = 0) {
    if (!currentStreamData) return;

    const wasPlaying = !video.paused;
    let streamUrl = "";
    if (isAudioTranscode) {
        streamTimeOffset = Math.floor(startTime);
        streamUrl = `${currentStreamData.transcodeUrl}&t=${streamTimeOffset}`;
    } else {
        streamTimeOffset = 0;
        streamUrl = currentStreamData.streamUrl;
    }

    video.src = streamUrl;

    spinner.style.display = "flex";
    spinnerText.innerText = "Connecting to swarm & buffering...";

    video.addEventListener("loadedmetadata", function onLoaded() {
        video.removeEventListener("loadedmetadata", onLoaded);
        if (!isAudioTranscode && startTime > 0) {
            video.currentTime = startTime;
        }
        if (wasPlaying) {
            video.play().catch(() => {});
        }
    });

    const playPromise = video.play();
    if (playPromise !== undefined) {
        playPromise.then(() => {
            if (video.muted) {
                unmutePill.style.display = "flex";
            }
        }).catch(() => {
            video.muted = true;
            updateVolume(0);
            video.play().then(() => {
                unmutePill.style.display = "flex";
            }).catch(() => {});
        });
    }
}

async function startStreamForTorrent(torrent) {
    activeTorrent = torrent;
    spinner.style.display = "flex";
    spinnerText.innerText = `Connecting to ${torrent.name.slice(0, 35)}...`;

    try {
        const res = await fetch("/api/torrent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ magnet: torrent.magnet })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load torrent");

        currentStreamData = data;
        hasProbedDuration = false;

        if (data.duration && data.duration > 0) {
            totalDuration = data.duration;
            hasProbedDuration = true;
            updateProgressUI();
        } else {
            pollDuration(data.infoHash);
        }

        // Set AAC transcode according to audio compatibility
        if (data.needsTranscode) {
            isAudioTranscode = true;
            audioFixSwitch.checked = true;
        } else {
            isAudioTranscode = false;
            audioFixSwitch.checked = false;
        }

        // Check for saved resume time
        let initialTime = 0;
        if (resumeStorageKey) {
            const savedSec = parseInt(localStorage.getItem(resumeStorageKey), 10);
            if (savedSec && savedSec > 10) {
                initialTime = savedSec;
                resumeText.innerText = `Resumed at ${formatTime(savedSec)}`;
                resumePill.style.display = "flex";
                setTimeout(() => { resumePill.style.display = "none"; }, 7000);
            }
        }

        loadVideoStream(initialTime);
    } catch (err) {
        spinner.style.display = "none";
        showToast("❌ Stream error: " + err.message, 4000);
    }
}

function handleServerChange(index) {
    const t = currentTorrents[index];
    if (t) {
        showToast(`Switching to: ${t.name.slice(0, 35)}...`);
        startStreamForTorrent(t);
    }
}

/* Hotkeys */
document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;

    if (e.code === "Space" || e.code === "KeyK") {
        e.preventDefault();
        togglePlay();
    } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        skip(-10);
    } else if (e.code === "ArrowRight") {
        e.preventDefault();
        skip(10);
    } else if (e.code === "KeyF") {
        e.preventDefault();
        toggleFullscreen();
    } else if (e.code === "KeyM") {
        e.preventDefault();
        toggleMute();
    } else if (e.code === "KeyP") {
        e.preventDefault();
        togglePip();
    }
});

/* Initialize Player by URL Route */
async function initPlayer() {
    const path = window.location.pathname;
    const movieMatch = path.match(/^\/movie\/([0-9]+)/i);
    const tvMatch = path.match(/^\/tv\/([0-9]+)\/([0-9]+)(?:\/(?:epesode\/)?([0-9]+))?/i);

    let apiUrl = null;
    let isTv = false;

    if (movieMatch) {
        apiUrl = `/api/movie/${movieMatch[1]}`;
        resumeStorageKey = `tp_resume_movie_${movieMatch[1]}`;
    } else if (tvMatch) {
        isTv = true;
        const tmdbId = tvMatch[1];
        const season = tvMatch[2];
        const episode = tvMatch[3] || 1;
        apiUrl = `/api/tv/${tmdbId}/${season}/${episode}`;
        resumeStorageKey = `tp_resume_tv_${tmdbId}_${season}_${episode}`;
    }

    if (!apiUrl) {
        spinnerText.innerText = "Invalid media URL";
        return;
    }

    spinner.style.display = "flex";
    spinnerText.innerText = "Analyzing streams & picking best torrent...";

    try {
        const res = await fetch(apiUrl);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load media metadata");

        currentMedia = data;
        currentTorrents = data.torrents || [];

        // Update Top Bar (Screenshot match)
        const tmdb = data.tmdb;
        const titleEl = document.getElementById("mediaTitleText");
        const badgeEl = document.getElementById("mediaBadge");

        if (data.mediaType === "movie") {
            const yearStr = tmdb.year ? ` ${tmdb.year}` : "";
            titleEl.innerText = `${tmdb.title}${yearStr}`;
            badgeEl.innerText = "MOVIE";
            document.title = `${tmdb.title} - Viewlix Player`;
        } else {
            const epTag = `TV S${tmdb.season}E${tmdb.episode}`;
            titleEl.innerText = `${tmdb.showName}`;
            badgeEl.innerText = epTag;
            document.title = `${tmdb.showName} ${epTag} - Viewlix Player`;
        }

        // Initialize duration from TMDB immediately so progress bar is live from 0s
        if (tmdb.runtime && tmdb.runtime > 0) {
            totalDuration = tmdb.runtime * 60;
        } else if (data.mediaType === "tv") {
            totalDuration = 50 * 60;
        } else {
            totalDuration = 115 * 60;
        }
        updateProgressUI();

        // Populate Server / Stream selector in Settings Menu (Top 3 Servers)
        serverSelect.innerHTML = "";
        currentTorrents.forEach((t, i) => {
            const opt = document.createElement("option");
            opt.value = i;
            const bestTag = i === 0 ? " [Best - Most Peers]" : "";
            const totalPeers = (t.seeders || 0) + (t.leechers || 0);
            opt.innerText = `Server ${i + 1}${bestTag}: ${t.seeders} seeds (${totalPeers} peers) • ${t.sizeFormatted}`;
            serverSelect.appendChild(opt);
        });

        // Automatically stream best torrent selected by algorithm!
        const best = data.bestTorrent || currentTorrents[0];
        if (best && best.magnet) {
            startStreamForTorrent(best);
        } else {
            spinner.style.display = "none";
            showToast("No active torrent streams found for this title.", 5000);
        }
    } catch (err) {
        spinner.style.display = "none";
        showToast("❌ " + err.message, 5000);
    }
}

// Ensure initPlayer is called exactly once
let playerInitialized = false;
function safeInitPlayer() {
    if (playerInitialized) return;
    playerInitialized = true;
    initPlayer();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", safeInitPlayer);
} else {
    safeInitPlayer();
}
