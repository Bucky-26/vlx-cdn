/**
 * ============================================================================
 * VIEWLIX STREAMING PLAYER — PLYR.IO & NETFLIX/HBO EPISODE SELECTION
 * ============================================================================
 */

let plyrInstance = null;
let currentMedia = null;
let currentSources = [];
let activeSource = null;
let currentStreamData = null;
let isAudioTranscode = false;
let streamTimeOffset = 0;
let totalDuration = 0;
let hasProbedDuration = false;
let durationPollTimer = null;
let controlsTimeout = null;
let resumeStorageKey = "";
let currentQuality = "1080p";
let availableQualities = [];
let nextPromptDismissed = false;
let nextCountdownTimer = null;
const seasonEpisodesCache = new Map(); // seasonNumber -> episodes array

// DOM Elements
const videoEl = document.getElementById("player");
const playerRoot = document.getElementById("playerRoot");
const spinner = document.getElementById("spinner");
const spinnerText = document.getElementById("spinnerText");
const spinnerSubtext = document.getElementById("spinnerSubtext");
const unmutePill = document.getElementById("unmutePill");
const resumePill = document.getElementById("resumePill");
const resumeText = document.getElementById("resumeText");
const topBar = document.getElementById("topBar");
const mediaTitleText = document.getElementById("mediaTitleText");
const mediaSubtitleText = document.getElementById("mediaSubtitleText");
const mediaBadge = document.getElementById("mediaBadge");
const topQualityBadge = document.getElementById("topQualityBadge");
const activeServerLabel = document.getElementById("activeServerLabel");
const btnEpisodesToggle = document.getElementById("btnEpisodesToggle");
const btnNextEp = document.getElementById("btnNextEp");
const toastNotice = document.getElementById("toastNotice");
const bufferingSpinner = document.getElementById("bufferingSpinner");

function showBuffering() {
    if (bufferingSpinner) bufferingSpinner.style.display = "flex";
}

function hideBuffering() {
    if (bufferingSpinner) bufferingSpinner.style.display = "none";
}

// Drawer & Modal Elements
const drawerBackdrop = document.getElementById("drawerBackdrop");
const episodesDrawer = document.getElementById("episodesDrawer");
const drawerShowTitle = document.getElementById("drawerShowTitle");
const seasonSelect = document.getElementById("seasonSelect");
const episodesCardsList = document.getElementById("episodesCardsList");
const serverModal = document.getElementById("serverModal");
const serverModalBackdrop = document.getElementById("serverModalBackdrop");
const qualityPills = document.getElementById("qualityPills");
const serverList = document.getElementById("serverList");
const audioFixSwitch = document.getElementById("audioFixSwitch");
const nextEpPrompt = document.getElementById("nextEpPrompt");
const nextPromptThumb = document.getElementById("nextPromptThumb");
const nextPromptTitle = document.getElementById("nextPromptTitle");
const nextPromptCountdown = document.getElementById("nextPromptCountdown");

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

function showToast(text, duration = 3000) {
    if (!toastNotice) return;
    toastNotice.innerText = text;
    toastNotice.classList.add("visible");
    setTimeout(() => toastNotice.classList.remove("visible"), duration);
}

/* ─────────────────────────────────────────────────────────────────────────────
   PROGRESS BAR & DURATION INTERCEPTION ENGINE
   ───────────────────────────────────────────────────────────────────────────── */

const nativeCurrentTimeDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
const nativeDurationDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration');

// Define robust getters/setters on videoEl so Plyr and HTML5 video are 100% in sync
try {
    Object.defineProperty(videoEl, 'duration', {
        get() {
            if (totalDuration && totalDuration > 0) return totalDuration;
            if (nativeDurationDesc) {
                const raw = nativeDurationDesc.get.call(videoEl);
                if (raw && !isNaN(raw) && isFinite(raw) && raw > 0) return raw;
            }
            return 0;
        },
        configurable: true
    });

    Object.defineProperty(videoEl, 'currentTime', {
        get() {
            if (!nativeCurrentTimeDesc) return 0;
            const raw = nativeCurrentTimeDesc.get.call(videoEl) || 0;
            if (isAudioTranscode) {
                return streamTimeOffset + raw;
            }
            return raw;
        },
        set(targetSec) {
            seekToTime(targetSec);
        },
        configurable: true
    });
} catch (e) {
    console.warn("Could not patch videoEl getters/setters:", e);
}

let transcodeSeekTimer = null;
function debouncedTranscodeSeek(targetSec) {
    clearTimeout(transcodeSeekTimer);
    showBuffering();
    transcodeSeekTimer = setTimeout(() => {
        streamTimeOffset = targetSec;
        loadVideoStream(targetSec);
    }, 150);
}

function seekToTime(targetSec) {
    targetSec = Math.max(0, Math.min(targetSec, totalDuration || targetSec));
    showBuffering();

    if (isAudioTranscode && currentStreamData) {
        debouncedTranscodeSeek(targetSec);
    } else if (videoEl) {
        if (nativeCurrentTimeDesc) {
            nativeCurrentTimeDesc.set.call(videoEl, targetSec);
        } else {
            videoEl.currentTime = targetSec;
        }
    }
}

function setTotalDuration(sec) {
    if (!sec || isNaN(sec) || sec <= 0) return;
    totalDuration = Math.round(sec);
    if (plyrInstance) {
        plyrInstance.config.duration = totalDuration;
        const durEl = plyrInstance.elements?.display?.duration;
        if (durEl) durEl.innerText = formatTime(totalDuration);
        const seekInput = plyrInstance.elements?.inputs?.seek;
        if (seekInput) {
            seekInput.setAttribute('aria-valuemax', totalDuration);
        }
    }
    try {
        videoEl.dispatchEvent(new Event('durationchange'));
    } catch (e) {}
    updateProgressBar();
}

function updateProgressBar() {
    const cur = getDisplayCurrentTime();
    const dur = getEffectiveDuration();

    if (dur > 0) {
        const pct = Math.min(100, Math.max(0, (cur / dur) * 100));

        // Update seek input slider and CSS fill track
        const seekInput = plyrInstance?.elements?.inputs?.seek;
        if (seekInput && !plyrInstance?.seeking) {
            seekInput.value = pct;
            seekInput.style.setProperty('--value', `${pct}%`);
            seekInput.setAttribute('aria-valuenow', Math.floor(cur));
        }

        // Update buffer bar (downloaded stream progress)
        const bufEl = plyrInstance?.elements?.display?.buffer;
        if (bufEl && videoEl && videoEl.buffered && videoEl.buffered.length > 0) {
            try {
                const lastBufferedEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
                const totalBufSec = isAudioTranscode ? streamTimeOffset + lastBufferedEnd : lastBufferedEnd;
                const bufPct = Math.min(100, Math.max(0, (totalBufSec / dur) * 100));
                bufEl.value = bufPct;
            } catch (e) {}
        }

        // Update current time & duration labels
        const curEl = plyrInstance?.elements?.display?.currentTime;
        if (curEl) {
            curEl.innerText = formatTime(cur);
        }

        const durEl = plyrInstance?.elements?.display?.duration;
        if (durEl && dur > 0) {
            durEl.innerText = formatTime(dur);
        }
    }
}

/* ─────────────────────────────────────────────────────────────────────────────
   INITIALIZE PLYR.IO PLAYER
   ───────────────────────────────────────────────────────────────────────────── */

function initPlyr() {
    if (plyrInstance) return plyrInstance;

    plyrInstance = new Plyr(videoEl, {
        controls: [
            'play-large',
            'play',
            'rewind',
            'fast-forward',
            'mute',
            'volume',
            'current-time',
            'progress',
            'duration',
            'settings',
            'pip',
            'fullscreen'
        ],
        settings: ['speed'],
        speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
        seekTime: 10,
        keyboard: { focused: true, global: true },
        tooltips: { controls: false, seek: true },
        storage: { enabled: false },
        hideControls: false,
        duration: totalDuration > 0 ? totalDuration : undefined
    });

    // Native video listener fallbacks for guaranteed progress bar sync
    videoEl.addEventListener('timeupdate', updateProgressBar);
    videoEl.addEventListener('durationchange', updateProgressBar);
    videoEl.addEventListener('loadedmetadata', updateProgressBar);

    // Direct Seek Input & Scrubber Binding (Click / Drag on Track)
    setTimeout(() => {
        const seekInput = plyrInstance.elements?.inputs?.seek;
        if (seekInput) {
            seekInput.addEventListener('input', (e) => {
                const pct = parseFloat(e.target.value);
                const dur = getEffectiveDuration();
                if (dur > 0 && !isNaN(pct)) {
                    const targetSec = (pct / 100) * dur;
                    const curEl = plyrInstance.elements?.display?.currentTime;
                    if (curEl) curEl.innerText = formatTime(targetSec);
                    seekInput.style.setProperty('--value', `${pct}%`);
                }
            });

            seekInput.addEventListener('change', (e) => {
                const pct = parseFloat(e.target.value);
                const dur = getEffectiveDuration();
                if (dur > 0 && !isNaN(pct)) {
                    const targetSec = (pct / 100) * dur;
                    seekToTime(targetSec);
                }
            });
        }

        // Attach hover protectors to Plyr controls bar so it NEVER disappears while mouse is over it
        const controlsEl = plyrInstance.elements?.controls || document.querySelector('.plyr__controls');
        if (controlsEl) {
            controlsEl.addEventListener('mouseenter', () => {
                isControlsHovered = true;
                showPlayerControls();
            });
            controlsEl.addEventListener('mouseleave', () => {
                isControlsHovered = false;
                scheduleControlsHide(CONTROLS_HIDE_DELAY_MS);
            });
        }

        // Inject bottom brand watermark logo (viewlix.png)
        const injectBottomBrand = () => {
            const ctrlEl = plyrInstance.elements?.controls || document.querySelector('.plyr__controls');
            if (!ctrlEl || ctrlEl.querySelector('.plyr__brand-watermark')) return;

            const brandDiv = document.createElement('div');
            brandDiv.className = 'plyr__controls__item plyr__brand-watermark';
            brandDiv.innerHTML = `
                <a href="/" class="bottom-brand-link" title="Viewlix" target="_blank" rel="noopener">
                    <img src="/images/viewlix.png" onerror="this.src='https://viewlix.site/viewlix.png'" alt="Viewlix" class="bottom-brand-logo">
                </a>
            `;

            const menuEl = ctrlEl.querySelector('.plyr__menu');
            if (menuEl) {
                ctrlEl.insertBefore(brandDiv, menuEl);
            } else {
                const fsEl = ctrlEl.querySelector('[data-plyr="fullscreen"]');
                if (fsEl) {
                    ctrlEl.insertBefore(brandDiv, fsEl);
                } else {
                    ctrlEl.appendChild(brandDiv);
                }
            }
        };

        injectBottomBrand();
        plyrInstance.on('ready', injectBottomBrand);
    }, 150);

    // Buffering & Loading Animation Handlers
    let stallTimer = null;

    plyrInstance.on('waiting', () => {
        showBuffering();
    });

    plyrInstance.on('stalled', () => {
        showBuffering();
        clearTimeout(stallTimer);
        // If stalled for > 5 seconds while video has buffered data, nudge playback
        stallTimer = setTimeout(() => {
            if (videoEl && !videoEl.paused && videoEl.readyState >= 2) {
                videoEl.play().catch(() => {});
            }
        }, 5000);
    });

    plyrInstance.on('canplay', () => {
        clearTimeout(stallTimer);
        hideBuffering();
        updateProgressBar();
    });

    plyrInstance.on('seeked', () => {
        if (videoEl && videoEl.readyState >= 3) {
            hideBuffering();
        }
        updateProgressBar();
    });

    // Handle Time Update for Progress Bar, Resuming & End-of-Episode Prompt
    plyrInstance.on('timeupdate', () => {
        if (bufferingSpinner && bufferingSpinner.style.display === "flex" && !videoEl.paused) {
            hideBuffering();
        }
        updateProgressBar();

        const currentTime = getDisplayCurrentTime();
        const duration = getEffectiveDuration();

        // Save resume time every few seconds
        if (resumeStorageKey && currentTime > 10 && duration > 30) {
            if (currentTime < duration - 15) {
                localStorage.setItem(resumeStorageKey, Math.floor(currentTime));
            } else {
                localStorage.removeItem(resumeStorageKey);
            }
        }

        // Check for Next Episode Prompt (last 35s of an episode for TV)
        if (currentMedia && currentMedia.mediaType === 'tv' && duration > 60 && !nextPromptDismissed) {
            const timeLeft = duration - currentTime;
            if (timeLeft <= 35 && timeLeft > 5) {
                showNextEpisodePrompt();
            } else if (timeLeft <= 0) {
                playNextEpisode();
            }
        }
    });

    // Transcode Seeking Support
    plyrInstance.on('seeking', () => {
        showBuffering();
        if (isAudioTranscode && currentStreamData) {
            const targetTime = plyrInstance.currentTime;
            if (Math.abs(targetTime - streamTimeOffset) > 2) {
                debouncedTranscodeSeek(targetTime);
            }
        }
    });

    plyrInstance.on('playing', () => {
        hideBuffering();
        updateProgressBar();
        showPlayerControls();
        scheduleControlsHide(CONTROLS_HIDE_DELAY_MS);
        if (unmutePill) unmutePill.style.display = "none";
    });

    plyrInstance.on('pause', () => {
        showPlayerControls();
    });

    plyrInstance.on('ended', () => {
        if (currentMedia && currentMedia.mediaType === 'tv') {
            playNextEpisode();
        }
    });

    return plyrInstance;
}

/* ─────────────────────────────────────────────────────────────────────────────
   UNIFIED CONTROLS VISIBILITY MANAGER (DESKTOP & MOBILE)
   ───────────────────────────────────────────────────────────────────────────── */

const CONTROLS_HIDE_DELAY_MS = 5000; // Auto-hide controls after 5 seconds of inactivity
let controlsIdleTimer = null;
let isControlsHovered = false;

function showPlayerControls() {
    clearTimeout(controlsIdleTimer);
    playerRoot.classList.remove("hide-controls");
    if (plyrInstance && plyrInstance.toggleControls) {
        plyrInstance.toggleControls(true);
    }
}

function scheduleControlsHide(delay = CONTROLS_HIDE_DELAY_MS) {
    clearTimeout(controlsIdleTimer);
    if (!videoEl || videoEl.paused || isControlsHovered) {
        playerRoot.classList.remove("hide-controls");
        return;
    }
    const isDrawerOpen = episodesDrawer && episodesDrawer.classList.contains("open");
    const isModalOpen = serverModal && serverModal.classList.contains("open");
    if (isDrawerOpen || isModalOpen) {
        playerRoot.classList.remove("hide-controls");
        return;
    }

    controlsIdleTimer = setTimeout(() => {
        if (!videoEl || videoEl.paused || isControlsHovered) {
            playerRoot.classList.remove("hide-controls");
            return;
        }
        const isDrawerOpen = episodesDrawer && episodesDrawer.classList.contains("open");
        const isModalOpen = serverModal && serverModal.classList.contains("open");
        if (!isDrawerOpen && !isModalOpen) {
            playerRoot.classList.add("hide-controls");
        }
    }, delay);
}

function onUserActivity() {
    showPlayerControls();
    scheduleControlsHide(CONTROLS_HIDE_DELAY_MS);
}

// Global activity listeners for desktop mouse & mobile touch
playerRoot.addEventListener("mousemove", onUserActivity);
playerRoot.addEventListener("mousedown", onUserActivity);
playerRoot.addEventListener("pointermove", onUserActivity);
playerRoot.addEventListener("touchmove", onUserActivity, { passive: true });

// Protect top-bar from auto-hiding when hovered
const topBarEl = document.getElementById("topBar");
if (topBarEl) {
    topBarEl.addEventListener("mouseenter", () => {
        isControlsHovered = true;
        showPlayerControls();
    });
    topBarEl.addEventListener("mouseleave", () => {
        isControlsHovered = false;
        scheduleControlsHide(CONTROLS_HIDE_DELAY_MS);
    });
}

// Mobile Double-Tap to Seek (10s back / 10s forward)
let lastTapTime = 0;
let lastTapX = 0;
const rippleLeft = document.getElementById("rippleLeft");
const rippleRight = document.getElementById("rippleRight");

function showSeekRipple(isRight) {
    const el = isRight ? rippleRight : rippleLeft;
    if (!el) return;
    el.classList.add("active");
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
        el.classList.remove("active");
    }, 450);
}

function handleMobileDoubleTap(clientX) {
    const now = Date.now();
    const dt = now - lastTapTime;
    const rect = playerRoot.getBoundingClientRect();
    const xRatio = (clientX - rect.left) / rect.width;

    if (dt > 0 && dt < 320 && Math.abs(clientX - lastTapX) < 90) {
        if (xRatio < 0.4) {
            // Rewind 10s
            if (plyrInstance) plyrInstance.rewind(10);
            showSeekRipple(false);
            lastTapTime = 0;
            return true;
        } else if (xRatio > 0.6) {
            // Forward 10s
            if (plyrInstance) plyrInstance.forward(10);
            showSeekRipple(true);
            lastTapTime = 0;
            return true;
        }
    }
    lastTapTime = now;
    lastTapX = clientX;
    return false;
}

playerRoot.addEventListener("touchstart", (e) => {
    onUserActivity();
    if (e.touches && e.touches.length === 1) {
        const touch = e.touches[0];
        // Skip double tap if interacting with interactive UI elements
        if (e.target.closest("#topBar") ||
            e.target.closest("#episodesDrawer") ||
            e.target.closest("#serverModal") ||
            e.target.closest("#nextEpPrompt") ||
            e.target.closest(".plyr__controls")) {
            return;
        }
        handleMobileDoubleTap(touch.clientX);
    }
}, { passive: true });

// Mobile Touch Swipe-to-Dismiss for Drawer & Server Modal
let drawerStartX = 0;
if (episodesDrawer) {
    episodesDrawer.addEventListener("touchstart", (e) => {
        if (e.touches.length === 1) drawerStartX = e.touches[0].clientX;
    }, { passive: true });

    episodesDrawer.addEventListener("touchend", (e) => {
        if (e.changedTouches.length === 1) {
            const dx = e.changedTouches[0].clientX - drawerStartX;
            if (dx > 75) {
                closeEpisodesDrawer();
            }
        }
    }, { passive: true });
}

let modalStartY = 0;
if (serverModal) {
    serverModal.addEventListener("touchstart", (e) => {
        if (e.touches.length === 1) modalStartY = e.touches[0].clientY;
    }, { passive: true });

    serverModal.addEventListener("touchend", (e) => {
        if (e.changedTouches.length === 1) {
            const dy = e.changedTouches[0].clientY - modalStartY;
            if (dy > 70 && window.innerWidth <= 640) {
                closeServerModal();
            }
        }
    }, { passive: true });
}

/* ─────────────────────────────────────────────────────────────────────────────
   STREAM PLAYBACK & DURATION ENGINE
   ───────────────────────────────────────────────────────────────────────────── */

function getDisplayCurrentTime() {
    if (!videoEl) return 0;
    if (nativeCurrentTimeDesc) {
        const raw = nativeCurrentTimeDesc.get.call(videoEl) || 0;
        return isAudioTranscode ? streamTimeOffset + raw : raw;
    }
    return videoEl.currentTime || 0;
}

function getEffectiveDuration() {
    if (totalDuration && totalDuration > 0) return totalDuration;
    if (nativeDurationDesc) {
        const raw = nativeDurationDesc.get.call(videoEl);
        if (raw && !isNaN(raw) && isFinite(raw) && raw > 0) return raw;
    }
    return 0;
}

function loadVideoStream(startTime = 0) {
    if (!currentStreamData) return;

    if (totalDuration > 60 && startTime >= totalDuration - 20) {
        startTime = 0;
    }

    let targetUrl = currentStreamData.streamUrl;
    if (isAudioTranscode) {
        streamTimeOffset = startTime;
        const sep = (currentStreamData.transcodeUrl || "").includes("?") ? "&" : "?";
        targetUrl = `${currentStreamData.transcodeUrl}${sep}t=${startTime}`;
    }

    spinner.style.display = "none";
    showBuffering();

    const wasPlaying = plyrInstance ? plyrInstance.playing : true;
    videoEl.src = targetUrl;

    videoEl.addEventListener("loadedmetadata", function onLoadedMeta() {
        videoEl.removeEventListener("loadedmetadata", onLoadedMeta);
        if (!isAudioTranscode && startTime > 0) {
            videoEl.currentTime = startTime;
        }
        if (wasPlaying) {
            plyrInstance.play().catch(() => {});
        }
    });

    plyrInstance.play().then(() => {
        if (videoEl.muted && unmutePill) {
            unmutePill.style.display = "flex";
        }
    }).catch(() => {
        videoEl.muted = true;
        plyrInstance.play().then(() => {
            if (unmutePill) unmutePill.style.display = "flex";
        }).catch(() => {});
    });
}

function pollDuration(infoHash) {
    if (hasProbedDuration) return;
    clearInterval(durationPollTimer);

    let attempts = 0;
    durationPollTimer = setInterval(async () => {
        attempts++;
        if (attempts > 12 || hasProbedDuration) {
            clearInterval(durationPollTimer);
            return;
        }

        try {
            const res = await fetch(`/api/duration/${infoHash}`);
            if (!res.ok) return;
            const data = await res.json();
            if (data.duration && data.duration > 0) {
                setTotalDuration(data.duration);
                hasProbedDuration = true;
                clearInterval(durationPollTimer);
            }
        } catch (e) {}
    }, 2000);
}

async function startStreamForSource(source) {
    activeSource = source;
    spinner.style.display = "flex";
    spinnerText.innerText = `Connecting to ${source.label || "stream"}...`;
    spinnerSubtext.innerText = "Synchronizing peer swarm...";

    if (activeServerLabel) {
        activeServerLabel.innerText = source.label || `Server (${source.quality || "HD"})`;
    }

    try {
        const season = currentMedia && currentMedia.tmdb ? currentMedia.tmdb.season : undefined;
        const episode = currentMedia && currentMedia.tmdb ? currentMedia.tmdb.episode : undefined;
        const res = await fetch("/api/source/select", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: source.id,
                infoHash: source.infoHash,
                fileIdx: source.fileIdx,
                season,
                episode,
                duration: totalDuration
            })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to connect to stream");

        currentStreamData = data;
        hasProbedDuration = false;

        if (data.duration && data.duration > 0) {
            setTotalDuration(data.duration);
            hasProbedDuration = true;
        } else {
            pollDuration(data.infoHash);
        }

        // Set audio transcode switch
        if (data.needsTranscode) {
            isAudioTranscode = true;
            if (audioFixSwitch) audioFixSwitch.checked = true;
        } else {
            isAudioTranscode = false;
            if (audioFixSwitch) audioFixSwitch.checked = false;
        }

        // Check for resume time
        const currentPos = getDisplayCurrentTime();
        let initialTime = currentPos > 5 ? currentPos : 0;

        if (initialTime === 0 && resumeStorageKey) {
            const savedSec = parseInt(localStorage.getItem(resumeStorageKey), 10);
            if (savedSec && savedSec > 10) {
                if (totalDuration > 60 && savedSec >= totalDuration - 30) {
                    localStorage.removeItem(resumeStorageKey);
                } else {
                    initialTime = savedSec;
                    if (resumeText) resumeText.innerText = `Resumed at ${formatTime(savedSec)}`;
                    if (resumePill) {
                        resumePill.style.display = "flex";
                        setTimeout(() => { resumePill.style.display = "none"; }, 7000);
                    }
                }
            }
        }

        loadVideoStream(initialTime);
    } catch (err) {
        spinner.style.display = "none";
        showToast("❌ " + err.message, 4000);
    }
}

/* ─────────────────────────────────────────────────────────────────────────────
   RESUME & UNMUTE ACTIONS
   ───────────────────────────────────────────────────────────────────────────── */

function handleUnmuteClick() {
    if (videoEl) videoEl.muted = false;
    if (plyrInstance) plyrInstance.muted = false;
    if (unmutePill) unmutePill.style.display = "none";
}

function startOver() {
    if (resumeStorageKey) localStorage.removeItem(resumeStorageKey);
    if (resumePill) resumePill.style.display = "none";
    if (isAudioTranscode) {
        streamTimeOffset = 0;
        loadVideoStream(0);
    } else if (videoEl) {
        videoEl.currentTime = 0;
    }
}

function closeResumePill() {
    if (resumePill) resumePill.style.display = "none";
}

/* ─────────────────────────────────────────────────────────────────────────────
   NETFLIX / HBO STYLE SEASONS & EPISODES DRAWER
   ───────────────────────────────────────────────────────────────────────────── */

function toggleEpisodesDrawer() {
    if (!episodesDrawer) return;
    if (episodesDrawer.classList.contains("open")) {
        closeEpisodesDrawer();
    } else {
        openEpisodesDrawer();
    }
}

function openEpisodesDrawer() {
    if (!episodesDrawer || !drawerBackdrop) return;
    closeServerModal();
    episodesDrawer.classList.add("open");
    drawerBackdrop.classList.add("active");
    playerRoot.classList.remove("hide-controls");
}

function closeEpisodesDrawer() {
    if (!episodesDrawer || !drawerBackdrop) return;
    episodesDrawer.classList.remove("open");
    drawerBackdrop.classList.remove("active");
}

function renderSeasonSelector(seasons, activeSeasonNum) {
    if (!seasonSelect || !seasons || seasons.length === 0) return;
    seasonSelect.innerHTML = "";

    seasons.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.seasonNumber;
        opt.innerText = `${s.name || `Season ${s.seasonNumber}`} (${s.episodeCount || 0} Episodes)`;
        if (s.seasonNumber === activeSeasonNum) opt.selected = true;
        seasonSelect.appendChild(opt);
    });
}

async function onSeasonChange(seasonNumber) {
    const seasonNum = parseInt(seasonNumber, 10);
    if (isNaN(seasonNum)) return;

    if (!currentMedia || !currentMedia.tmdb) return;
    const tmdbId = currentMedia.tmdb.id;

    // Check if season episodes are cached
    if (seasonEpisodesCache.has(seasonNum)) {
        renderEpisodeCards(seasonEpisodesCache.get(seasonNum), seasonNum);
        return;
    }

    if (episodesCardsList) {
        episodesCardsList.innerHTML = `<div style="text-align:center; padding: 40px; color:#94a3b8;">Loading Season ${seasonNum} episodes...</div>`;
    }

    try {
        const res = await fetch(`/api/tv/${tmdbId}/season/${seasonNum}/episodes`);
        const data = await res.json();
        const eps = data.episodes || [];
        seasonEpisodesCache.set(seasonNum, eps);
        renderEpisodeCards(eps, seasonNum);
    } catch (err) {
        if (episodesCardsList) {
            episodesCardsList.innerHTML = `<div style="text-align:center; padding: 40px; color:#ef4444;">Failed to load episodes.</div>`;
        }
    }
}

function renderEpisodeCards(episodes, seasonNum) {
    if (!episodesCardsList || !episodes) return;
    episodesCardsList.innerHTML = "";

    const activeEpNum = currentMedia && currentMedia.tmdb ? currentMedia.tmdb.episode : 1;
    const activeSeasonNum = currentMedia && currentMedia.tmdb ? currentMedia.tmdb.season : 1;
    const fallbackImage = (currentMedia && currentMedia.tmdb && currentMedia.tmdb.backdrop) || "/favicon.ico";

    episodes.forEach((ep) => {
        const isCurrentlyPlaying = (seasonNum === activeSeasonNum) && (ep.episodeNumber === activeEpNum);

        const card = document.createElement("div");
        card.className = `episode-card${isCurrentlyPlaying ? " active" : ""}`;
        card.onclick = () => selectEpisodeToPlay(seasonNum, ep.episodeNumber);

        const stillUrl = ep.still || fallbackImage;

        card.innerHTML = `
            <div class="episode-thumb-wrap">
                <img class="episode-thumb" src="${stillUrl}" alt="${ep.name}" loading="lazy" onerror="this.src='${fallbackImage}'">
                <div class="episode-play-overlay">
                    <div class="play-circle">▶</div>
                </div>
                ${ep.runtime ? `<div class="episode-runtime-badge">${ep.runtime}m</div>` : ""}
            </div>
            <div class="episode-info">
                <div class="episode-title-row">
                    <div class="episode-num-title">${ep.episodeNumber}. ${ep.name}</div>
                    ${isCurrentlyPlaying ? `<span class="active-playing-tag">▶ PLAYING</span>` : ""}
                </div>
                <div class="episode-synopsis">${ep.overview || "No synopsis available for this episode."}</div>
            </div>
        `;

        episodesCardsList.appendChild(card);
    });
}

function selectEpisodeToPlay(seasonNum, episodeNum) {
    if (!currentMedia || !currentMedia.tmdb) return;
    const activeEpNum = currentMedia.tmdb.episode;
    const activeSeasonNum = currentMedia.tmdb.season;

    if (seasonNum === activeSeasonNum && episodeNum === activeEpNum) {
        closeEpisodesDrawer();
        return;
    }

    const tmdbId = currentMedia.tmdb.id;
    window.location.href = `/tv/${tmdbId}/${seasonNum}/${episodeNum}`;
}

function playNextEpisode() {
    if (!currentMedia || currentMedia.mediaType !== 'tv') return;
    const tmdb = currentMedia.tmdb;
    const nextEp = tmdb.episode + 1;
    const seasonNum = tmdb.season;

    // Check if next episode exists in current season
    const currentSeasonEps = seasonEpisodesCache.get(seasonNum) || (tmdb.episodes || []);
    const existsInSeason = currentSeasonEps.some(e => e.episodeNumber === nextEp);

    if (existsInSeason) {
        window.location.href = `/tv/${tmdb.id}/${seasonNum}/${nextEp}`;
    } else {
        // Try next season episode 1
        const nextSeason = seasonNum + 1;
        const seasonExists = (tmdb.seasons || []).some(s => s.seasonNumber === nextSeason);
        if (seasonExists) {
            window.location.href = `/tv/${tmdb.id}/${nextSeason}/1`;
        } else {
            showToast("You've reached the end of the series!");
        }
    }
}

function showNextEpisodePrompt() {
    if (!nextEpPrompt || nextPromptDismissed) return;
    const tmdb = currentMedia && currentMedia.tmdb;
    if (!tmdb) return;

    const nextEpNum = tmdb.episode + 1;
    const currentSeasonEps = seasonEpisodesCache.get(tmdb.season) || (tmdb.episodes || []);
    const nextEpData = currentSeasonEps.find(e => e.episodeNumber === nextEpNum);

    if (!nextEpData) return;

    if (nextPromptTitle) nextPromptTitle.innerText = `${nextEpNum}. ${nextEpData.name}`;
    if (nextPromptThumb) nextPromptThumb.src = nextEpData.still || tmdb.backdrop || "";

    nextEpPrompt.style.display = "flex";

    let countdown = 10;
    if (nextPromptCountdown) nextPromptCountdown.innerText = countdown;

    clearInterval(nextCountdownTimer);
    nextCountdownTimer = setInterval(() => {
        countdown--;
        if (nextPromptCountdown) nextPromptCountdown.innerText = countdown;
        if (countdown <= 0) {
            clearInterval(nextCountdownTimer);
            playNextEpisode();
        }
    }, 1000);
}

function dismissNextPrompt() {
    nextPromptDismissed = true;
    clearInterval(nextCountdownTimer);
    if (nextEpPrompt) nextEpPrompt.style.display = "none";
}

/* ─────────────────────────────────────────────────────────────────────────────
   SERVER & QUALITY SETTINGS MODAL
   ───────────────────────────────────────────────────────────────────────────── */

function toggleServerModal() {
    if (!serverModal) return;
    if (serverModal.classList.contains("open")) {
        closeServerModal();
    } else {
        openServerModal();
    }
}

function openServerModal() {
    if (!serverModal || !serverModalBackdrop) return;
    closeEpisodesDrawer();
    serverModal.classList.add("open");
    serverModalBackdrop.classList.add("active");
    playerRoot.classList.remove("hide-controls");
}

function closeServerModal() {
    if (!serverModal || !serverModalBackdrop) return;
    serverModal.classList.remove("open");
    serverModalBackdrop.classList.remove("active");
}

function populateQualityPills(qualities) {
    if (!qualityPills) return;
    qualityPills.innerHTML = "";

    const allQualities = ["Auto", ...(qualities || ["1080p", "720p"])];
    allQualities.forEach((q) => {
        const pill = document.createElement("button");
        pill.className = `quality-pill${q === currentQuality ? " active" : ""}`;
        pill.innerText = q;
        pill.onclick = () => selectQuality(q);
        qualityPills.appendChild(pill);
    });
}

function selectQuality(q) {
    currentQuality = q;
    populateQualityPills(availableQualities);
    if (topQualityBadge) topQualityBadge.innerText = q;

    if (q === "Auto") {
        if (currentSources.length > 0) startStreamForSource(currentSources[0]);
    } else {
        const matched = currentSources.find(s => s.quality === q) || currentSources[0];
        if (matched) startStreamForSource(matched);
    }
    closeServerModal();
}

function populateServerList(sources) {
    if (!serverList) return;
    serverList.innerHTML = "";

    sources.forEach((s, idx) => {
        const item = document.createElement("div");
        const isActive = activeSource && (activeSource.infoHash === s.infoHash);
        item.className = `server-item${isActive ? " active" : ""}`;
        item.innerHTML = `
            <span>${s.label || `Server ${idx + 1} (${s.quality || "HD"})`}</span>
            ${isActive ? `<span class="server-check">✓ Active</span>` : ""}
        `;
        item.onclick = () => {
            startStreamForSource(s);
            populateServerList(currentSources);
            closeServerModal();
        };
        serverList.appendChild(item);
    });
}

function toggleAudioTranscode() {
    isAudioTranscode = audioFixSwitch ? audioFixSwitch.checked : !isAudioTranscode;
    const currentPos = getDisplayCurrentTime();
    showToast(isAudioTranscode ? "🔊 Audio transcode enabled" : "⚡ Direct video enabled");
    loadVideoStream(currentPos);
}

/* ─────────────────────────────────────────────────────────────────────────────
   INITIALIZE PLAYER VIA SSE STREAM PIPELINE
   ───────────────────────────────────────────────────────────────────────────── */

async function initPlayer() {
    initPlyr();

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
    spinnerSubtext.innerText = "Searching high-speed sources";

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
                return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

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
                    const lines = buffer.split("\n");
                    buffer = lines.pop(); // keep incomplete trailing line

                    let currentEvent = "";
                    let currentData = "";

                    for (const line of lines) {
                        if (line.startsWith("event: ")) {
                            currentEvent = line.slice(7).trim();
                        } else if (line.startsWith("data: ")) {
                            currentData = line.slice(6).trim();
                        } else if (line === "") {
                            if (currentEvent && currentData) {
                                try {
                                    const payload = JSON.parse(currentData);
                                    handleSSEEvent(currentEvent, payload);
                                } catch (e) {}
                                currentEvent = "";
                                currentData = "";
                            }
                        }
                    }
                }
            };

            processChunk();
        }).catch((err) => {
            clearTimeout(timeoutId);
            if (err.name !== "AbortError") {
                spinner.style.display = "none";
                showToast("❌ Failed to connect to stream", 5000);
            }
        });
    }

    function handleSSEEvent(event, data) {
        if (event === "meta") {
            // ── Phase 1: TMDB info + candidate sources ───────────────────────
            currentMedia = data;
            currentSources = data.sources || [];
            availableQualities = data.qualities || ["1080p"];

            const tmdb = data.tmdb;
            if (data.mediaType === "movie") {
                const yearStr = tmdb.year ? ` (${tmdb.year})` : "";
                if (mediaTitleText) mediaTitleText.innerText = `${tmdb.title}${yearStr}`;
                if (mediaBadge) mediaBadge.innerText = "MOVIE";
                if (mediaSubtitleText) mediaSubtitleText.style.display = "none";
                if (btnEpisodesToggle) btnEpisodesToggle.style.display = "none";
                if (btnNextEp) btnNextEp.style.display = "none";
                document.title = `${tmdb.title} - Viewlix Player`;
            } else {
                // TV Series
                if (mediaTitleText) mediaTitleText.innerText = `${tmdb.showName}`;
                if (mediaBadge) mediaBadge.innerText = "TV SERIES";
                if (mediaSubtitleText) {
                    mediaSubtitleText.innerText = `S${tmdb.season} : E${tmdb.episode} • ${tmdb.episodeTitle || "Episode"}`;
                    mediaSubtitleText.style.display = "block";
                }
                if (btnEpisodesToggle) btnEpisodesToggle.style.display = "inline-flex";
                if (btnNextEp) btnNextEp.style.display = "inline-flex";
                document.title = `${tmdb.showName} S${tmdb.season}E${tmdb.episode} - Viewlix Player`;

                // Set up Netflix / HBO style Episodes Drawer
                if (drawerShowTitle) drawerShowTitle.innerText = tmdb.showName;
                if (tmdb.seasons) {
                    renderSeasonSelector(tmdb.seasons, tmdb.season);
                }
                if (tmdb.episodes) {
                    seasonEpisodesCache.set(tmdb.season, tmdb.episodes);
                    renderEpisodeCards(tmdb.episodes, tmdb.season);
                }
            }

            // Duration baseline from TMDB or media type
            if (tmdb.runtime && tmdb.runtime > 0) {
                setTotalDuration(tmdb.runtime * 60);
            } else if (data.mediaType === "tv") {
                setTotalDuration(50 * 60);
            } else {
                setTotalDuration(115 * 60);
            }

            // Populate Quality and Server options
            currentQuality = data.currentQuality || (currentSources[0] ? currentSources[0].quality : "1080p");
            if (topQualityBadge) topQualityBadge.innerText = currentQuality;
            populateQualityPills(availableQualities);
            populateServerList(currentSources);

            if (currentSources.length > 0) {
                activeSource = currentSources[0];
                if (activeServerLabel) activeServerLabel.innerText = activeSource.label || `Server 1 (${activeSource.quality || "HD"})`;
            }

            spinnerText.innerText = "Connecting to peer stream...";
            spinnerSubtext.innerText = "Synchronizing video pieces";

            if (currentSources.length === 0) {
                spinner.style.display = "none";
                showToast("No stream sources found for this title.", 5000);
            }

        } else if (event === "stream") {
            // ── Phase 2: Torrent is ready — start playback ───────────────────
            currentStreamData = data;
            hasProbedDuration = false;

            if (data.duration && data.duration > 0) {
                setTotalDuration(data.duration);
                hasProbedDuration = true;
            } else {
                pollDuration(data.infoHash);
            }

            if (data.needsTranscode) {
                isAudioTranscode = true;
                if (audioFixSwitch) audioFixSwitch.checked = true;
            } else {
                isAudioTranscode = false;
                if (audioFixSwitch) audioFixSwitch.checked = false;
            }

            // Check resume position
            let initialTime = 0;
            if (resumeStorageKey) {
                const savedSec = parseInt(localStorage.getItem(resumeStorageKey), 10);
                if (savedSec && savedSec > 10) {
                    if (totalDuration > 60 && savedSec >= totalDuration - 30) {
                        localStorage.removeItem(resumeStorageKey);
                    } else {
                        initialTime = savedSec;
                        if (resumeText) resumeText.innerText = `Resumed at ${formatTime(savedSec)}`;
                        if (resumePill) {
                            resumePill.style.display = "flex";
                            setTimeout(() => { resumePill.style.display = "none"; }, 7000);
                        }
                    }
                }
            }

            if (!activeSource && currentSources.length > 0) {
                activeSource = currentSources.find(s => s.infoHash === data.infoHash) || currentSources[0];
                if (activeServerLabel) activeServerLabel.innerText = activeSource.label || "Server 1 (1080p)";
            }

            loadVideoStream(initialTime);

        } else if (event === "stream_error") {
            spinner.style.display = "none";
            showToast("⚠️ Auto-connect failed. Try selecting another server in Settings.", 5000);
        } else if (event === "error") {
            spinner.style.display = "none";
            showToast("❌ " + (data.error || "Failed to load stream"), 5000);
        }
    }
}

/* ─────────────────────────────────────────────────────────────────────────────
   KEYBOARD SHORTCUTS
   ───────────────────────────────────────────────────────────────────────────── */

document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;

    if (e.code === "Escape") {
        closeEpisodesDrawer();
        closeServerModal();
        dismissNextPrompt();
    } else if (e.code === "KeyE") {
        if (currentMedia && currentMedia.mediaType === 'tv') {
            toggleEpisodesDrawer();
        }
    } else if (e.code === "KeyN") {
        if (currentMedia && currentMedia.mediaType === 'tv') {
            playNextEpisode();
        }
    }
});

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


// Clear focus from player buttons after click to prevent sticky tooltips or focus rings
document.addEventListener('mouseup', (e) => {
    const btn = e.target.closest('.plyr__controls button, .plyr__controls [data-plyr]');
    if (btn) btn.blur();
});

// Release active stream immediately when tab closes or navigates away
window.addEventListener("beforeunload", () => {
    if (activeSource && activeSource.infoHash) {
        try {
            navigator.sendBeacon("/api/stream/stop", new Blob([JSON.stringify({ infoHash: activeSource.infoHash })], { type: "application/json" }));
        } catch (e) {}
    }
});
window.addEventListener("pagehide", () => {
    if (activeSource && activeSource.infoHash) {
        try {
            navigator.sendBeacon("/api/stream/stop", new Blob([JSON.stringify({ infoHash: activeSource.infoHash })], { type: "application/json" }));
        } catch (e) {}
    }
});
