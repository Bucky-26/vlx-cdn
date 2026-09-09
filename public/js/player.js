let currentMedia = null;
let currentSources = [];
let activeSource = null;
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
let currentQuality = "1080p";
let availableQualities = [];

// DOM Elements
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

// Quality Elements
const qualityBtn = document.getElementById("qualityBtn");
const currentQualityLabel = document.getElementById("currentQualityLabel");
const qualityMenu = document.getElementById("qualityMenu");
const qualityOptionsList = document.getElementById("qualityOptionsList");
const topQualityBadge = document.getElementById("topQualityBadge");
const settingsQualityBadge = document.getElementById("settingsQualityBadge");
const qualitySelect = document.getElementById("qualitySelect");

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

/* Idle Controls Auto-Hide */
function resetControlsTimer() {
    playerRoot.classList.remove("hide-controls");
    clearTimeout(controlsTimeout);
    if (!video.paused) {
        controlsTimeout = setTimeout(() => {
            const isMenuOpen = (settingsMenu && settingsMenu.classList.contains("open")) ||
                               (qualityMenu && qualityMenu.classList.contains("open"));
            if (!isMenuOpen && !isDragging) {
                playerRoot.classList.add("hide-controls");
            }
        }, 2800);
    }
}

playerRoot.addEventListener("mousemove", resetControlsTimer);
playerRoot.addEventListener("click", resetControlsTimer);

/* Play / Pause */
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
    if (playIcon) playIcon.style.display = "none";
    if (pauseIcon) pauseIcon.style.display = "block";
    resetControlsTimer();
});

video.addEventListener("pause", () => {
    if (playIcon) playIcon.style.display = "block";
    if (pauseIcon) pauseIcon.style.display = "none";
    playerRoot.classList.remove("hide-controls");
});

function skip(deltaSeconds) {
    const current = getDisplayCurrentTime();
    const dur = getEffectiveDuration();
    const target = Math.max(0, Math.min(dur || Infinity, current + deltaSeconds));
    seekTo(target);
    showCenterIcon(deltaSeconds > 0);
}

/* Volume & Mute */
function updateVolume(val) {
    video.volume = parseFloat(val);
    video.muted = video.volume === 0;
    syncVolumeUI();
}

function toggleMute() {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) {
        video.volume = 1;
        if (volSlider) volSlider.value = 1;
    }
    syncVolumeUI();
}

function syncVolumeUI() {
    const volHigh = document.getElementById("volHighIcon");
    const volMute = document.getElementById("volMuteIcon");
    if (video.muted || video.volume === 0) {
        if (volHigh) volHigh.style.display = "none";
        if (volMute) volMute.style.display = "block";
        if (volSlider) volSlider.value = 0;
    } else {
        if (volHigh) volHigh.style.display = "block";
        if (volMute) volMute.style.display = "none";
        if (volSlider) volSlider.value = video.volume;
    }
}

function handleUnmuteClick() {
    video.muted = false;
    video.volume = 1;
    if (volSlider) volSlider.value = 1;
    syncVolumeUI();
    if (unmutePill) unmutePill.style.display = "none";
    video.play().catch(() => {});
}

/* Fullscreen & Picture-in-Picture */
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
    } else if (video && video.requestPictureInPicture) {
        video.requestPictureInPicture().catch(() => {});
    }
}

/* Resume Pill */
function closeResumePill() {
    if (resumePill) resumePill.style.display = "none";
}

function startOver() {
    closeResumePill();
    if (resumeStorageKey) localStorage.removeItem(resumeStorageKey);
    seekTo(0);
}

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
        if (playedBar) playedBar.style.width = pct + "%";
        if (scrubberThumb) scrubberThumb.style.left = pct + "%";
        if (timeStamp) timeStamp.innerText = `${formatTime(current)} / ${formatTime(dur)}`;
    } else {
        if (playedBar) playedBar.style.width = "0%";
        if (scrubberThumb) scrubberThumb.style.left = "0%";
        if (timeStamp) timeStamp.innerText = `${formatTime(current)} / --:--`;
    }
}

function updateBufferedBar() {
    const dur = getEffectiveDuration();
    if (dur > 0 && video.buffered && video.buffered.length > 0 && bufferedBar) {
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
    if (!isAudioTranscode && isFinite(video.duration) && video.duration > 300) {
        totalDuration = video.duration;
    }
    updateProgressUI();
    updateBufferedBar();
});

video.addEventListener("durationchange", () => {
    if (!isAudioTranscode && isFinite(video.duration) && video.duration > 300) {
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
        streamTimeOffset = Math.floor(bounded);
        updateProgressUI(bounded);
        spinner.style.display = "flex";
        spinnerText.innerText = `Seeking to ${formatTime(bounded)}...`;

        const base = currentStreamData ? currentStreamData.transcodeUrl : (activeSource ? activeSource.transcodeUrl : "");
        video.src = `${base}&t=${streamTimeOffset}`;
        video.currentTime = 0;
        video.play().catch(() => {});
    } else {
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

if (timeline) {
    timeline.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        isDragging = true;
        isSeeking = true;
        timeline.classList.add("dragging");
        try { timeline.setPointerCapture(e.pointerId); } catch (err) {}

        const { ratio, time } = getTimelineTimeFromEvent(e);
        if (playedBar) playedBar.style.width = (ratio * 100) + "%";
        if (scrubberThumb) scrubberThumb.style.left = (ratio * 100) + "%";
        updateProgressUI(time);

        if (timeTooltip) {
            timeTooltip.style.display = "block";
            const tipX = Math.max(24, Math.min(timeline.clientWidth - 24, ratio * timeline.clientWidth));
            timeTooltip.style.left = tipX + "px";
            timeTooltip.innerText = formatTime(time);
        }
    });

    timeline.addEventListener("pointermove", (e) => {
        const { ratio, time } = getTimelineTimeFromEvent(e);
        if (timeTooltip) {
            const tipX = Math.max(24, Math.min(timeline.clientWidth - 24, ratio * timeline.clientWidth));
            timeTooltip.style.left = tipX + "px";
            timeTooltip.innerText = formatTime(time);
        }

        if (isDragging) {
            if (playedBar) playedBar.style.width = (ratio * 100) + "%";
            if (scrubberThumb) scrubberThumb.style.left = (ratio * 100) + "%";
            updateProgressUI(time);
        } else {
            const dur = getEffectiveDuration();
            if (dur > 0 && timeTooltip) {
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
    timeline.addEventListener("mouseleave", () => {
        if (!isDragging && timeTooltip) {
            timeTooltip.style.display = "none";
        }
    });
}

/* Quality & Settings Menus */
function toggleSettings() {
    if (qualityMenu && qualityMenu.classList.contains("open")) {
        qualityMenu.classList.remove("open");
    }
    if (settingsMenu) settingsMenu.classList.toggle("open");
}

function toggleQualityMenu() {
    if (settingsMenu && settingsMenu.classList.contains("open")) {
        settingsMenu.classList.remove("open");
    }
    if (qualityMenu) qualityMenu.classList.toggle("open");
}

function closeQualityMenu() {
    if (qualityMenu) qualityMenu.classList.remove("open");
}

document.addEventListener("click", (e) => {
    if (settingsMenu && settingsMenu.classList.contains("open") && !settingsMenu.contains(e.target) && !settingsBtn.contains(e.target)) {
        settingsMenu.classList.remove("open");
    }
    if (qualityMenu && qualityMenu.classList.contains("open") && !qualityMenu.contains(e.target) && !qualityBtn.contains(e.target)) {
        closeQualityMenu();
    }
});

function updateQualityUI(quality) {
    currentQuality = quality;
    if (currentQualityLabel) currentQualityLabel.innerText = quality;
    if (topQualityBadge) topQualityBadge.innerText = quality;
    if (settingsQualityBadge) settingsQualityBadge.innerText = `${quality} HD`;
    if (qualitySelect) qualitySelect.value = quality;

    document.querySelectorAll(".quality-option").forEach((el) => {
        if (el.dataset.quality === quality) {
            el.classList.add("active");
        } else {
            el.classList.remove("active");
        }
    });
}

function populateQualityOptions(qualities) {
    availableQualities = qualities && qualities.length > 0 ? qualities : ["1080p"];

    if (qualityOptionsList) {
        qualityOptionsList.innerHTML = "";

        const autoOpt = document.createElement("div");
        autoOpt.className = "quality-option" + (currentQuality === "Auto" ? " active" : "");
        autoOpt.dataset.quality = "Auto";
        autoOpt.innerText = "Auto";
        autoOpt.onclick = () => handleQualitySelect("Auto");
        qualityOptionsList.appendChild(autoOpt);

        availableQualities.forEach((q) => {
            const opt = document.createElement("div");
            opt.className = "quality-option" + (currentQuality === q ? " active" : "");
            opt.dataset.quality = q;
            opt.innerText = q;
            opt.onclick = () => handleQualitySelect(q);
            qualityOptionsList.appendChild(opt);
        });
    }

    if (qualitySelect) {
        qualitySelect.innerHTML = "";
        const autoOpt = document.createElement("option");
        autoOpt.value = "Auto";
        autoOpt.innerText = "Auto (Best Available)";
        qualitySelect.appendChild(autoOpt);

        availableQualities.forEach((q) => {
            const opt = document.createElement("option");
            opt.value = q;
            opt.innerText = `${q} High Definition`;
            qualitySelect.appendChild(opt);
        });
        qualitySelect.value = currentQuality;
    }
}

function handleQualitySelect(selectedQuality) {
    closeQualityMenu();
    if (selectedQuality === currentQuality && activeSource) return;

    showToast(`Switching quality to ${selectedQuality}...`);
    updateQualityUI(selectedQuality);

    let targetSource = null;
    if (selectedQuality === "Auto") {
        targetSource = currentSources[0];
    } else {
        targetSource = currentSources.find((s) => s.quality === selectedQuality) || currentSources[0];
    }

    if (targetSource) {
        const idx = currentSources.findIndex((s) => s.id === targetSource.id);
        if (idx !== -1 && serverSelect) {
            serverSelect.value = idx;
        }
        startStreamForSource(targetSource);
    }
}

function handleServerChange(index) {
    const s = currentSources[index];
    if (s) {
        showToast(`Connecting to ${s.label}...`);
        if (s.quality) {
            updateQualityUI(s.quality);
        }
        startStreamForSource(s);
    }
}

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
    spinnerText.innerText = "Buffering video stream...";

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
            if (video.muted && unmutePill) {
                unmutePill.style.display = "flex";
            }
        }).catch(() => {
            video.muted = true;
            updateVolume(0);
            video.play().then(() => {
                if (unmutePill) unmutePill.style.display = "flex";
            }).catch(() => {});
        });
    }
}

async function startStreamForSource(source) {
    activeSource = source;
    spinner.style.display = "flex";
    spinnerText.innerText = `Connecting to stream (${source.quality || "HD"})...`;

    try {
        const res = await fetch("/api/source/select", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: source.id, infoHash: source.infoHash, duration: totalDuration })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to connect to stream");

        currentStreamData = data;
        hasProbedDuration = false;

        if (data.duration && data.duration > 0) {
            totalDuration = data.duration;
            hasProbedDuration = true;
            updateProgressUI();
        } else {
            pollDuration(data.infoHash);
        }

        // Set audio transcode
        if (data.needsTranscode) {
            isAudioTranscode = true;
            if (audioFixSwitch) audioFixSwitch.checked = true;
        } else {
            isAudioTranscode = false;
            if (audioFixSwitch) audioFixSwitch.checked = false;
        }

        // Check for saved resume time or preserve mid-stream seek
        const currentPos = getDisplayCurrentTime();
        let initialTime = currentPos > 5 ? currentPos : 0;

        if (initialTime === 0 && resumeStorageKey) {
            const savedSec = parseInt(localStorage.getItem(resumeStorageKey), 10);
            if (savedSec && savedSec > 10) {
                initialTime = savedSec;
                if (resumeText) resumeText.innerText = `Resumed at ${formatTime(savedSec)}`;
                if (resumePill) {
                    resumePill.style.display = "flex";
                    setTimeout(() => { resumePill.style.display = "none"; }, 7000);
                }
            }
        }

        loadVideoStream(initialTime);
    } catch (err) {
        spinner.style.display = "none";
        showToast("❌ " + err.message, 4000);
    }
}

/* Keyboard Hotkeys */
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

/* Initialize Player via SSE — streams data in two fast phases:
 * Phase 1 (meta): TMDB info + sources arrive quickly → UI renders immediately
 * Phase 2 (stream): Torrent ready → video auto-starts without a second request
 */
async function initPlayer() {
    const path = window.location.pathname;
    const movieMatch = path.match(/^\/movie\/([0-9]+)/i);
    const tvMatch = path.match(/^\/tv\/([0-9]+)\/([0-9]+)(?:\/(?:epesode\/)?([0-9]+))?/i);

    let apiUrl = null;

    if (movieMatch) {
        apiUrl = `/api/movie/${movieMatch[1]}`;
        resumeStorageKey = `tp_resume_movie_${movieMatch[1]}`;
    } else if (tvMatch) {
        const tmdbId = tvMatch[1];
        const season = tvMatch[2];
        const episode = tvMatch[3] || 1;
        apiUrl = `/api/tv/${tmdbId}/${season}/${episode}`;
        resumeStorageKey = `tp_resume_tv_${tmdbId}_${season}_${episode}`;
    }

    if (!apiUrl) {
        if (spinnerText) spinnerText.innerText = "Invalid media URL";
        return;
    }

    spinner.style.display = "flex";
    spinnerText.innerText = "Finding the best stream...";

    return new Promise((resolve) => {
        // Use SSE to receive media data as it becomes available
        const evtSrc = new EventSource(apiUrl, {
            // SSE requires GET — headers not directly settable, but server
            // detects EventSource via Accept: text/event-stream automatically
        });

        // Workaround: EventSource doesn't allow custom headers in browser.
        // We fetch with Accept header instead, and parse the SSE stream manually.
        evtSrc.close();

        // Manual SSE fetch (supports custom Accept header)
        fetchSSE(apiUrl);

        function fetchSSE(url) {
            const ctrl = new AbortController();
            const timeoutId = setTimeout(() => ctrl.abort(), 40000);

            fetch(url, {
                headers: { "Accept": "text/event-stream" },
                signal: ctrl.signal
            }).then(async (res) => {
                clearTimeout(timeoutId);
                if (!res.ok) {
                    const errData = await res.json().catch(() => ({ error: "Failed to load stream" }));
                    spinner.style.display = "none";
                    showToast("❌ " + (errData.error || "Failed to load stream"), 5000);
                    resolve();
                    return;
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                let metaReceived = false;

                const processChunk = async () => {
                    while (true) {
                        let result;
                        try {
                            result = await reader.read();
                        } catch (e) {
                            break;
                        }
                        if (result.done) break;

                        buffer += decoder.decode(result.value, { stream: true });

                        // Parse SSE events from buffer
                        const lines = buffer.split("\n");
                        buffer = lines.pop(); // keep incomplete last line

                        let currentEvent = "";
                        let currentData = "";

                        for (const line of lines) {
                            if (line.startsWith("event: ")) {
                                currentEvent = line.slice(7).trim();
                            } else if (line.startsWith("data: ")) {
                                currentData = line.slice(6).trim();
                            } else if (line === "") {
                                // Dispatch event
                                if (currentEvent && currentData) {
                                    try {
                                        const payload = JSON.parse(currentData);
                                        handleSSEEvent(currentEvent, payload);
                                        if (currentEvent === "meta") metaReceived = true;
                                    } catch (e) {}
                                    currentEvent = "";
                                    currentData = "";
                                }
                            }
                        }
                    }
                    resolve();
                };

                processChunk();
            }).catch((err) => {
                clearTimeout(timeoutId);
                if (err.name !== "AbortError") {
                    spinner.style.display = "none";
                    showToast("❌ Failed to connect to stream", 5000);
                }
                resolve();
            });
        }

        function handleSSEEvent(event, data) {
            if (event === "meta") {
                // ── Phase 1: Got TMDB info + sources ─────────────────────
                currentMedia = data;
                currentSources = data.sources || [];

                const tmdb = data.tmdb;
                const titleEl = document.getElementById("mediaTitleText");
                const badgeEl = document.getElementById("mediaBadge");

                if (data.mediaType === "movie") {
                    const yearStr = tmdb.year ? ` ${tmdb.year}` : "";
                    if (titleEl) titleEl.innerText = `${tmdb.title}${yearStr}`;
                    if (badgeEl) badgeEl.innerText = "MOVIE";
                    document.title = `${tmdb.title} - Viewlix Player`;
                } else {
                    const epTag = `TV S${tmdb.season}E${tmdb.episode}`;
                    if (titleEl) titleEl.innerText = `${tmdb.showName}`;
                    if (badgeEl) badgeEl.innerText = epTag;
                    document.title = `${tmdb.showName} ${epTag} - Viewlix Player`;
                }

                // Initialize duration estimate from TMDB
                if (tmdb.runtime && tmdb.runtime > 0) {
                    totalDuration = tmdb.runtime * 60;
                } else if (data.mediaType === "tv") {
                    totalDuration = 50 * 60;
                } else {
                    totalDuration = 115 * 60;
                }
                updateProgressUI();

                // Populate quality + server UI
                const initialQuality = data.currentQuality || (currentSources[0] ? currentSources[0].quality : "1080p");
                updateQualityUI(initialQuality);
                populateQualityOptions(data.qualities);

                if (serverSelect) {
                    serverSelect.innerHTML = "";
                    currentSources.forEach((s, i) => {
                        const opt = document.createElement("option");
                        opt.value = i;
                        opt.innerText = s.label || `Server ${i + 1} (${s.quality || "HD"})`;
                        serverSelect.appendChild(opt);
                    });
                }

                spinnerText.innerText = "Preparing video stream...";

                if (currentSources.length === 0) {
                    spinner.style.display = "none";
                    showToast("No stream sources found for this title.", 5000);
                }

            } else if (event === "stream") {
                // ── Phase 2: Stream is ready — start playing immediately! ─
                currentStreamData = data;
                hasProbedDuration = false;

                if (data.duration && data.duration > 0) {
                    totalDuration = data.duration;
                    hasProbedDuration = true;
                    updateProgressUI();
                } else {
                    pollDuration(data.infoHash);
                }

                // Detect if audio transcoding needed
                if (data.needsTranscode) {
                    isAudioTranscode = true;
                    if (audioFixSwitch) audioFixSwitch.checked = true;
                } else {
                    isAudioTranscode = false;
                    if (audioFixSwitch) audioFixSwitch.checked = false;
                }

                // Restore resume position if any
                let initialTime = 0;
                if (resumeStorageKey) {
                    const savedSec = parseInt(localStorage.getItem(resumeStorageKey), 10);
                    if (savedSec && savedSec > 10) {
                        initialTime = savedSec;
                        if (resumeText) resumeText.innerText = `Resumed at ${formatTime(savedSec)}`;
                        if (resumePill) {
                            resumePill.style.display = "flex";
                            setTimeout(() => { resumePill.style.display = "none"; }, 7000);
                        }
                    }
                }

                // Also set activeSource from currentSources
                if (!activeSource && currentSources.length > 0) {
                    activeSource = currentSources.find((s) => s.infoHash === data.infoHash) || currentSources[0];
                }

                loadVideoStream(initialTime);

            } else if (event === "stream_error") {
                // Stream prep failed — but we still have sources user can manually try
                spinner.style.display = "none";
                showToast("⚠️ Auto-connect failed. Try selecting a different server.", 5000);

            } else if (event === "error") {
                spinner.style.display = "none";
                showToast("❌ " + (data.error || "Failed to load stream"), 5000);
            }
        }
    });
}

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
