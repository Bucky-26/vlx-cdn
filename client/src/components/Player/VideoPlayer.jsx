import React, { useEffect, useRef, useState, useCallback } from 'react';
import { 
  ArrowLeft, Server, Volume2, Volume1, VolumeX, List, Play, Pause, 
  RotateCcw, RotateCw, Maximize, Minimize, Check, RefreshCw, 
  AlertCircle, X, Sparkles, Sliders
} from 'lucide-react';
import { syncWatchProgress, getWatchHistory } from '../../services/supabaseClient';

export default function VideoPlayer({ mediaId, mediaType = 'movie', season = 1, episode = 1, onBack }) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const progressContainerRef = useRef(null);
  const syncTimerRef = useRef(null);
  const controlsTimeoutRef = useRef(null);
  const currentInfoHashRef = useRef(null);
  const streamStartTimeRef = useRef(0);
  const [streamStartTime, setStreamStartTime] = useState(0);
  const seekDebounceRef = useRef(null);

  // Auto Audio Transcode (ON by default, persistent)
  const [autoTranscode, setAutoTranscode] = useState(() => {
    return localStorage.getItem('viewlix_auto_transcode') !== 'false';
  });

  // Media & Stream State
  const [meta, setMeta] = useState(null);
  const [sources, setSources] = useState([]);
  const [currentSource, setCurrentSource] = useState(null);
  const [rawStreamData, setRawStreamData] = useState(null);
  const [streamUrl, setStreamUrl] = useState(null);
  const [statusMessage, setStatusMessage] = useState('Connecting to Viewlix media swarm...');
  const [loading, setLoading] = useState(true);

  // Player State
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedPct, setBufferedPct] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);

  // Hover Tooltip on Progress Scrubber
  const [hoverTime, setHoverTime] = useState(null);
  const [hoverPosition, setHoverPosition] = useState(0);

  // Modals & Drawers
  const [showServerModal, setShowServerModal] = useState(false);
  const [showEpisodeDrawer, setShowEpisodeDrawer] = useState(false);
  const [resumePrompt, setResumePrompt] = useState(null);
  const [toastMessage, setToastMessage] = useState(null);

  const totalDurationRef = useRef(0);

  const showToast = (msg) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Helper to notify server when leaving or stopping a stream
  const notifyStreamStop = useCallback((hash) => {
    const targetHash = hash || currentInfoHashRef.current;
    if (!targetHash) return;
    try {
      const payload = JSON.stringify({ infoHash: targetHash });
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/stream/stop", new Blob([payload], { type: "application/json" }));
      } else {
        fetch("/api/stream/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true
        }).catch(() => {});
      }
    } catch (e) {}
  }, []);

  const formatTime = (seconds) => {
    if (!seconds || isNaN(seconds) || seconds < 0) return "0:00";
    const totalSec = Math.floor(seconds);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  // Compute final stream URL based on Auto Audio Transcode preference and optional seek time
  const computeFinalStreamUrl = useCallback((streamData, transcodePref, startTimeSec = 0) => {
    if (!streamData) return null;
    const baseSrc = streamData.streamUrl || `/stream/${streamData.infoHash}`;
    const needsConversion = Boolean(streamData.needsTranscode);
    
    // If autoTranscode is ON and stream has incompatible audio/video, transcode to AAC/H.264
    if (transcodePref && needsConversion) {
      const sep = baseSrc.includes('?') ? '&' : '?';
      return startTimeSec > 0
        ? `${baseSrc}${sep}transcode=audio&t=${Math.floor(startTimeSec)}`
        : `${baseSrc}${sep}transcode=audio`;
    }
    return baseSrc;
  }, []);

  // Connect to SSE Media Stream API
  useEffect(() => {
    const sseUrl = mediaType === 'movie' 
      ? `/api/movie/${mediaId}`
      : `/api/tv/${mediaId}/${season}/${episode}`;

    setLoading(true);
    setStatusMessage(`Finding English media stream for ${mediaType === 'movie' ? 'movie' : `S${season}E${episode}`}...`);

    const abortController = new AbortController();

    const handleStreamReady = (data) => {
      setRawStreamData(data);
      if (data.infoHash) {
        currentInfoHashRef.current = data.infoHash;
      }

      streamStartTimeRef.current = 0;
      setStreamStartTime(0);

      const finalSrc = computeFinalStreamUrl(data, autoTranscode);
      setStreamUrl(finalSrc);
      setLoading(false);

      if (data.duration && data.duration > 0) {
        totalDurationRef.current = data.duration;
        setDuration(data.duration);
      }

      if (videoRef.current) {
        videoRef.current.src = finalSrc;
        videoRef.current.load();
        const p = videoRef.current.play();
        if (p && typeof p.then === 'function') {
          p.then(() => {
            setIsBuffering(false);
            setIsPlaying(true);
          }).catch(() => {
            // If browser autoplay policy prevents audio playback, attempt muted autoplay
            if (videoRef.current) {
              videoRef.current.muted = true;
              videoRef.current.play().then(() => {
                setIsBuffering(false);
                setIsPlaying(true);
              }).catch(() => {
                setIsBuffering(false);
                setIsPlaying(false);
              });
            } else {
              setIsBuffering(false);
              setIsPlaying(false);
            }
          });
        }
      }

      checkResumeProgress();
    };

    fetch(sseUrl, {
      headers: { "Accept": "text/event-stream" },
      signal: abortController.signal
    }).then(async (res) => {
      if (!res.ok) {
        setLoading(false);
        setStatusMessage("Failed to load stream");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
        buffer = lines.pop() || "";

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
                if (currentEvent === "meta") {
                  setMeta(payload.tmdb);
                  setSources(payload.sources || []);
                  if (payload.sources && payload.sources.length > 0) {
                    const non4k = payload.sources.find(s => {
                      const q = (s.quality || "").toLowerCase();
                      return q !== "4k" && q !== "2160p";
                    });
                    setCurrentSource(payload.bestSource || non4k || payload.sources[0]);
                  }
                  if (payload.tmdb?.runtime && payload.tmdb.runtime > 0) {
                    const durSec = payload.tmdb.runtime * 60;
                    totalDurationRef.current = durSec;
                    setDuration(durSec);
                  }
                } else if (currentEvent === "stream" || currentEvent === "ready") {
                  handleStreamReady(payload);
                  if (payload.id || payload.infoHash) {
                    const found = (payload.sources || []).find(s => (s.id || s.infoHash || "").toLowerCase() === (payload.id || payload.infoHash || "").toLowerCase());
                    if (found) setCurrentSource(found);
                  }
                }
              } catch (e) {}
              currentEvent = "";
              currentData = "";
            }
          }
        }
      }
    }).catch((err) => {
      if (err.name !== "AbortError") {
        console.warn("SSE fetch error:", err);
      }
    });

    return () => {
      abortController.abort();
      notifyStreamStop();
      if (videoRef.current) {
        try {
          videoRef.current.pause();
          videoRef.current.removeAttribute("src");
          videoRef.current.load();
        } catch (e) {}
      }
    };
  }, [mediaId, mediaType, season, episode, autoTranscode, computeFinalStreamUrl, notifyStreamStop]);

  // Tab unload / navigate beacon
  useEffect(() => {
    const handleLeave = () => notifyStreamStop();
    window.addEventListener("beforeunload", handleLeave);
    window.addEventListener("pagehide", handleLeave);
    return () => {
      window.removeEventListener("beforeunload", handleLeave);
      window.removeEventListener("pagehide", handleLeave);
    };
  }, [notifyStreamStop]);

  // Execute seek: Native Range seek for direct MP4, or fast timestamp &t= jump for Transcode
  const executeSeek = useCallback((targetSec) => {
    const video = videoRef.current;
    if (!video) return;

    const effDur = totalDurationRef.current > 0 ? totalDurationRef.current : (duration || 0);
    const clamped = Math.max(0, Math.min(effDur > 0 ? effDur - 0.5 : 100000, targetSec));
    
    const isTranscoding = Boolean(autoTranscode && rawStreamData?.needsTranscode) || Boolean(streamUrl && streamUrl.includes('transcode=audio'));

    if (!isTranscoding) {
      // Direct HTTP 206 range stream: browser handles partial requests natively
      video.currentTime = clamped;
      setCurrentTime(clamped);
      return;
    }

    // Transcode mode: Check if clamped target is already inside video's buffered ranges
    const localVideoTime = clamped - streamStartTimeRef.current;
    let isBufferedLocally = false;
    if (video.buffered && video.buffered.length > 0 && localVideoTime >= 0) {
      for (let i = 0; i < video.buffered.length; i++) {
        if (localVideoTime >= video.buffered.start(i) && localVideoTime <= video.buffered.end(i) - 0.5) {
          isBufferedLocally = true;
          break;
        }
      }
    }

    if (isBufferedLocally) {
      video.currentTime = localVideoTime;
      setCurrentTime(clamped);
      return;
    }

    // Target is outside current buffer: seek immediately on the server with &t=
    setCurrentTime(clamped);
    setIsBuffering(true);

    if (seekDebounceRef.current) {
      clearTimeout(seekDebounceRef.current);
    }

    seekDebounceRef.current = setTimeout(() => {
      if (!videoRef.current || !rawStreamData) return;
      const targetInt = Math.floor(clamped);
      streamStartTimeRef.current = targetInt;
      setStreamStartTime(targetInt);

      const newUrl = computeFinalStreamUrl(rawStreamData, true, targetInt);
      setStreamUrl(newUrl);

      const vid = videoRef.current;
      vid.src = newUrl;
      vid.load();
      const p = vid.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          setIsBuffering(false);
          setIsPlaying(true);
        }).catch(() => {
          setIsBuffering(false);
        });
      }
    }, 250);
  }, [autoTranscode, rawStreamData, streamUrl, duration, computeFinalStreamUrl]);

  // Video Event Handlers
  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;

    const isTranscoding = Boolean(autoTranscode && rawStreamData?.needsTranscode) || Boolean(streamUrl && streamUrl.includes('transcode=audio'));
    const effectiveTime = isTranscoding 
      ? (streamStartTimeRef.current + (video.currentTime || 0))
      : (video.currentTime || 0);

    setCurrentTime(effectiveTime);

    const effectiveDur = totalDurationRef.current > 0 ? totalDurationRef.current : (video.duration || 0);
    if (effectiveDur > 0 && effectiveDur !== duration) {
      setDuration(effectiveDur);
    }

    if (video.buffered && video.buffered.length > 0 && effectiveDur > 0) {
      try {
        const lastBuffered = isTranscoding
          ? (streamStartTimeRef.current + video.buffered.end(video.buffered.length - 1))
          : video.buffered.end(video.buffered.length - 1);
        setBufferedPct(Math.min(100, (lastBuffered / effectiveDur) * 100));
      } catch (e) {}
    }
  };

  const handlePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const handleSeekDelta = (deltaSec) => {
    const isTranscoding = Boolean(autoTranscode && rawStreamData?.needsTranscode) || Boolean(streamUrl && streamUrl.includes('transcode=audio'));
    const cur = isTranscoding 
      ? (streamStartTimeRef.current + (videoRef.current?.currentTime || 0))
      : (videoRef.current?.currentTime || 0);
    executeSeek(cur + deltaSec);
    showToast(deltaSec > 0 ? `+${deltaSec}s` : `${deltaSec}s`);
  };

  // Scrubber Progress Click / Drag
  const handleScrubberClick = (e) => {
    const container = progressContainerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const clickX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const pct = clickX / rect.width;
    const effDur = totalDurationRef.current > 0 ? totalDurationRef.current : (duration || 0);
    if (effDur > 0) {
      const targetSec = pct * effDur;
      executeSeek(targetSec);
    }
  };

  const handleScrubberMouseMove = (e) => {
    const container = progressContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mouseX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const pct = mouseX / rect.width;
    const effDur = totalDurationRef.current > 0 ? totalDurationRef.current : (duration || 0);
    if (effDur > 0) {
      setHoverTime(formatTime(pct * effDur));
      setHoverPosition(mouseX);
    }
  };

  const handleScrubberMouseLeave = () => {
    setHoverTime(null);
  };

  // Volume & Mute
  const handleVolumeChange = (e) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
      setIsMuted(val === 0);
    }
  };

  const handleToggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (videoRef.current) {
      videoRef.current.muted = nextMuted;
      if (!nextMuted && volume === 0) {
        setVolume(0.5);
        videoRef.current.volume = 0.5;
      }
    }
  };

  // Playback Speed Toggle
  const handleCycleSpeed = () => {
    const speeds = [1, 1.25, 1.5, 2, 0.75];
    const nextIdx = (speeds.indexOf(playbackSpeed) + 1) % speeds.length;
    const nextSpeed = speeds[nextIdx];
    setPlaybackSpeed(nextSpeed);
    if (videoRef.current) {
      videoRef.current.playbackRate = nextSpeed;
    }
    showToast(`Speed: ${nextSpeed}x`);
  };

  // Fullscreen Toggle
  const handleToggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen?.();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.();
      setIsFullscreen(false);
    }
  };

  // Toggle Auto Audio Transcode OFF / ON
  const handleToggleAutoTranscode = () => {
    const nextPref = !autoTranscode;
    setAutoTranscode(nextPref);
    localStorage.setItem('viewlix_auto_transcode', String(nextPref));

    if (rawStreamData && videoRef.current) {
      const isTranscoding = Boolean(autoTranscode && rawStreamData?.needsTranscode) || Boolean(streamUrl && streamUrl.includes('transcode=audio'));
      const currentPos = isTranscoding 
        ? (streamStartTimeRef.current + (videoRef.current.currentTime || 0)) 
        : (videoRef.current.currentTime || 0);

      const wasPlaying = !videoRef.current.paused;
      const willTranscode = nextPref && rawStreamData.needsTranscode;
      const targetStart = willTranscode ? Math.floor(currentPos) : 0;
      streamStartTimeRef.current = targetStart;
      setStreamStartTime(targetStart);

      const newUrl = computeFinalStreamUrl(rawStreamData, nextPref, targetStart);
      setStreamUrl(newUrl);

      videoRef.current.src = newUrl;
      if (!willTranscode) {
        videoRef.current.currentTime = currentPos;
      }
      if (wasPlaying) {
        videoRef.current.play().catch(() => {});
      }
    }

    showToast(nextPref 
      ? '🔊 Auto Audio Transcode: ON (Converts AC3/MKV to AAC/H.264)' 
      : '⚡ Auto Audio Transcode: OFF (Direct Pass-Through)'
    );
  };

  // Switch Server Source
  const handleSelectSource = (src) => {
    const nextHash = (src.infoHash || src.id || "").toLowerCase();
    if (currentInfoHashRef.current && currentInfoHashRef.current.toLowerCase() !== nextHash) {
      notifyStreamStop(currentInfoHashRef.current);
    }
    currentInfoHashRef.current = nextHash;
    setCurrentSource(src);
    setShowServerModal(false);

    if (!videoRef.current) return;
    const isTranscoding = Boolean(autoTranscode && rawStreamData?.needsTranscode) || Boolean(streamUrl && streamUrl.includes('transcode=audio'));
    const currentPos = isTranscoding 
      ? (streamStartTimeRef.current + (videoRef.current.currentTime || 0)) 
      : (videoRef.current.currentTime || 0);

    const baseSrc = `/stream/${src.infoHash}`;
    const targetStart = autoTranscode ? Math.floor(currentPos) : 0;
    streamStartTimeRef.current = targetStart;
    setStreamStartTime(targetStart);

    const newSrc = autoTranscode 
      ? `${baseSrc}?transcode=audio${targetStart > 0 ? `&t=${targetStart}` : ''}`
      : baseSrc;

    setStreamUrl(newSrc);
    videoRef.current.src = newSrc;
    if (!autoTranscode) {
      videoRef.current.currentTime = currentPos;
    }
    videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    showToast(`Switched to ${src.label || 'Server'}`);
  };

  // Check Watch History & Resume
  const checkResumeProgress = async () => {
    const history = await getWatchHistory();
    const existing = history.find(h => 
      String(h.tmdb_id) === String(mediaId) && 
      h.media_type === mediaType &&
      (mediaType === 'movie' || (h.season === Number(season) && h.episode === Number(episode)))
    );

    if (existing && existing.progress_seconds > 30 && !existing.completed) {
      setResumePrompt({
        seconds: existing.progress_seconds,
        formatted: formatTime(existing.progress_seconds)
      });
    }
  };

  const handleResume = () => {
    if (resumePrompt) {
      executeSeek(resumePrompt.seconds);
      setResumePrompt(null);
      showToast(`Resumed playback at ${resumePrompt.formatted}`);
    }
  };

  // Sync Watch Progress to Supabase every 15s
  useEffect(() => {
    syncTimerRef.current = setInterval(() => {
      if (!videoRef.current || videoRef.current.paused || !meta) return;
      const isTranscoding = Boolean(autoTranscode && rawStreamData?.needsTranscode) || Boolean(streamUrl && streamUrl.includes('transcode=audio'));
      const cur = isTranscoding 
        ? (streamStartTimeRef.current + (videoRef.current.currentTime || 0)) 
        : (videoRef.current.currentTime || 0);
      const dur = totalDurationRef.current > 0 ? totalDurationRef.current : (videoRef.current.duration || 0);
      if (dur > 0 && cur > 5) {
        syncWatchProgress({
          tmdbId: mediaId,
          mediaType,
          title: meta.title || meta.showName,
          posterPath: meta.posterPath,
          season: mediaType === 'tv' ? season : null,
          episode: mediaType === 'tv' ? episode : null,
          episodeName: meta.episodeName,
          progressSeconds: cur,
          durationSeconds: dur,
          completed: cur / dur > 0.92
        });
      }
    }, 15000);

    return () => clearInterval(syncTimerRef.current);
  }, [mediaId, mediaType, season, episode, meta, autoTranscode, rawStreamData, streamUrl]);

  // Auto-hide controls on inactivity (3.5s)
  const resetControlsTimeout = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    if (isPlaying) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3500);
    }
  };

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      resetControlsTimeout();

      if (e.code === 'Space' || e.key === 'k') {
        e.preventDefault();
        handlePlayPause();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        handleSeekDelta(-10);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        handleSeekDelta(10);
      } else if (e.code === 'KeyM') {
        handleToggleMute();
      } else if (e.code === 'KeyF') {
        handleToggleFullscreen();
      } else if (e.code === 'KeyT') {
        handleToggleAutoTranscode();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, isMuted, autoTranscode, rawStreamData]);

  // Scrubber percentage
  const playedPct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  return (
    <div 
      ref={containerRef}
      className={`untitledui-player ${!showControls ? 'untitledui-hide-controls' : ''}`}
      onMouseMove={resetControlsTimeout}
      onTouchStart={resetControlsTimeout}
    >
      {/* Video Element */}
      <video
        ref={videoRef}
        className="untitledui-video"
        playsInline
        preload="auto"
        onClick={handlePlayPause}
        onTimeUpdate={handleTimeUpdate}
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => { setIsBuffering(false); setIsPlaying(true); }}
        onCanPlay={() => setIsBuffering(false)}
        onPlay={() => setIsBuffering(false)}
        onPause={() => setIsPlaying(false)}
        onLoadedMetadata={handleTimeUpdate}
        onError={() => setIsBuffering(false)}
      />

      {/* Center Buffering Overlay — pure loading animation, no text or caption */}
      {isBuffering && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 30,
          pointerEvents: 'none'
        }}>
          <div className="untitledui-loading-spinner" />
        </div>
      )}

      {!isPlaying && !isBuffering && (
        <div className="untitledui-center-play" onClick={handlePlayPause} title="Play">
          <Play size={32} style={{ marginLeft: '4px' }} />
        </div>
      )}

      {/* Floating Top Header (Untitled UI Minimalist Glass) */}
      <div className="untitledui-top-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
          <button 
            onClick={onBack}
            className="untitledui-btn"
            title="Back to Catalog"
          >
            <ArrowLeft size={18} />
          </button>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h1 style={{ fontSize: '0.96rem', fontWeight: 700, color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {meta?.title || meta?.showName || 'Media Stream'}
              </h1>
              {meta?.year && (
                <span style={{ fontSize: '0.74rem', color: '#94a3b8', backgroundColor: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: '4px' }}>
                  {meta.year}
                </span>
              )}
              <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#f87171', backgroundColor: 'rgba(229, 9, 20, 0.14)', border: '1px solid rgba(229, 9, 20, 0.3)', padding: '1px 6px', borderRadius: '4px' }}>
                {currentSource?.quality || '1080p'}
              </span>
            </div>
            {mediaType === 'tv' && (
              <p style={{ fontSize: '0.78rem', color: '#94a3b8', margin: 0 }}>
                Season {season} Episode {episode} {meta?.episodeName ? `• ${meta.episodeName}` : ''}
              </p>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* TV Episode Drawer Button */}
          {mediaType === 'tv' && (
            <button 
              onClick={() => setShowEpisodeDrawer(true)} 
              className="untitledui-btn" 
              title="Episodes"
            >
              <List size={18} />
            </button>
          )}

          {/* Server Switcher Pill */}
          <button 
            onClick={() => setShowServerModal(true)} 
            className="untitledui-toggle-badge inactive"
            title="Switch Server"
          >
            <Server size={13} />
            <span>{currentSource?.label || 'Servers'}</span>
          </button>
        </div>
      </div>

      {/* Floating Bottom Controls (Untitled UI Video Player Bar) */}
      <div className="untitledui-bottom-bar">
        {/* Scrubber / Progress Slider */}
        <div 
          ref={progressContainerRef}
          className="untitledui-progress-container"
          onClick={handleScrubberClick}
          onMouseMove={handleScrubberMouseMove}
          onMouseLeave={handleScrubberMouseLeave}
        >
          {hoverTime && (
            <div 
              className="untitledui-tooltip"
              style={{ left: `${hoverPosition}px` }}
            >
              {hoverTime}
            </div>
          )}
          <div className="untitledui-progress-track">
            <div 
              className="untitledui-progress-buffer" 
              style={{ width: `${bufferedPct}%` }}
            />
            <div 
              className="untitledui-progress-played" 
              style={{ width: `${playedPct}%` }}
            />
          </div>
          <div 
            className="untitledui-progress-thumb" 
            style={{ left: `${playedPct}%` }}
          />
        </div>

        {/* Controls Row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          {/* Left Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {/* Play/Pause Button */}
            <button 
              onClick={handlePlayPause}
              className="untitledui-btn untitledui-btn-play"
              title={isPlaying ? "Pause (Space)" : "Play (Space)"}
            >
              {isPlaying ? <Pause size={17} /> : <Play size={17} style={{ marginLeft: '2px' }} />}
            </button>

            {/* Rewind 10s */}
            <button 
              onClick={() => handleSeekDelta(-10)}
              className="untitledui-btn"
              title="Rewind 10s (Left Arrow)"
            >
              <RotateCcw size={16} />
            </button>

            {/* Forward 10s */}
            <button 
              onClick={() => handleSeekDelta(10)}
              className="untitledui-btn"
              title="Forward 10s (Right Arrow)"
            >
              <RotateCw size={16} />
            </button>

            {/* Volume Control */}
            <div className="untitledui-volume-group">
              <button 
                onClick={handleToggleMute}
                className="untitledui-btn"
                title={isMuted ? "Unmute (M)" : "Mute (M)"}
              >
                {isMuted || volume === 0 ? <VolumeX size={17} /> : volume < 0.5 ? <Volume1 size={17} /> : <Volume2 size={17} />}
              </button>
              <input 
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="untitledui-volume-slider"
                title="Volume"
              />
            </div>

            {/* Time Counter */}
            <div className="untitledui-time">
              <span>{formatTime(currentTime)}</span>
              <span style={{ margin: '0 4px', opacity: 0.4 }}>/</span>
              <span style={{ opacity: 0.6 }}>{formatTime(duration)}</span>
            </div>
          </div>

          {/* Center Brand Watermark */}
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <a 
              href="/" 
              onClick={(e) => { e.preventDefault(); onBack(); }}
              title="Viewlix"
              style={{ display: 'flex', alignItems: 'center', opacity: 0.85, transition: 'opacity 0.2s' }}
              onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
              onMouseLeave={(e) => e.currentTarget.style.opacity = '0.85'}
            >
              <img 
                src="/images/viewlix.png" 
                onError={(e) => { e.currentTarget.src = "https://viewlix.site/viewlix.png"; }}
                alt="Viewlix" 
                style={{ height: '18px', width: 'auto', filter: 'drop-shadow(0 0 8px rgba(229, 9, 20, 0.45))' }}
              />
            </a>
          </div>

          {/* Right Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {/* Auto Audio Transcode Switch */}
            <button
              onClick={handleToggleAutoTranscode}
              className={`untitledui-toggle-badge ${autoTranscode ? 'active' : 'inactive'}`}
              title={autoTranscode 
                ? "Auto Audio Transcode is ON: Converts incompatible AC3/EAC3/MKV audio to AAC automatically" 
                : "Auto Audio Transcode is OFF: Raw direct stream pass-through"}
            >
              <span className="untitledui-toggle-dot" />
              <span>{autoTranscode ? "Auto Transcode: ON" : "Auto Transcode: OFF"}</span>
            </button>

            {/* Playback Speed */}
            <button 
              onClick={handleCycleSpeed}
              className="untitledui-btn"
              title="Playback Speed"
              style={{ fontSize: '0.78rem', fontWeight: 700 }}
            >
              {playbackSpeed}x
            </button>

            {/* Fullscreen Button */}
            <button 
              onClick={handleToggleFullscreen}
              className="untitledui-btn"
              title={isFullscreen ? "Exit Fullscreen (F)" : "Fullscreen (F)"}
            >
              {isFullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
            </button>
          </div>
        </div>
      </div>

      {/* Resume Prompt Toast Pill */}
      {resumePrompt && (
        <div style={{
          position: 'absolute',
          bottom: '88px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: 'rgba(18, 18, 24, 0.95)',
          backdropFilter: 'blur(16px)',
          border: '1px solid rgba(255, 255, 255, 0.15)',
          borderRadius: '30px',
          padding: '8px 18px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          boxShadow: '0 10px 30px rgba(0, 0, 0, 0.8)',
          zIndex: 50
        }}>
          <span style={{ fontSize: '0.84rem', color: '#e2e8f0', fontWeight: 500 }}>
            Resume from <strong style={{ color: '#ffffff' }}>{resumePrompt.formatted}</strong>?
          </span>
          <button 
            onClick={handleResume}
            className="btn-crimson"
            style={{ padding: '4px 12px', fontSize: '0.78rem', borderRadius: '20px' }}
          >
            Resume
          </button>
          <button 
            onClick={() => setResumePrompt(null)}
            style={{ color: '#94a3b8', padding: '2px', display: 'flex' }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Toast Notice */}
      {toastMessage && (
        <div style={{
          position: 'absolute',
          top: '76px',
          left: '50%',
          transform: 'translateX(-50%)',
          backgroundColor: 'rgba(18, 18, 24, 0.95)',
          backdropFilter: 'blur(16px)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          color: '#ffffff',
          padding: '8px 18px',
          borderRadius: '24px',
          fontSize: '0.84rem',
          fontWeight: 600,
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
          zIndex: 50
        }}>
          {toastMessage}
        </div>
      )}

      {/* Server Selection Modal (Untitled UI Dialog) */}
      {showServerModal && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.75)',
          backdropFilter: 'blur(12px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 60
        }}>
          <div style={{
            backgroundColor: '#121217',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: '16px',
            width: '90%',
            maxWidth: '460px',
            padding: '24px',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Server size={18} color="#e50914" />
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>Select Streaming Server</h3>
              </div>
              <button onClick={() => setShowServerModal(false)} className="untitledui-btn">
                <X size={18} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {sources.map((s, idx) => {
                const isSelected = currentSource?.infoHash === s.infoHash;
                return (
                  <button
                    key={idx}
                    onClick={() => handleSelectSource(s)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 16px',
                      borderRadius: '10px',
                      backgroundColor: isSelected ? 'rgba(229, 9, 20, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                      border: `1px solid ${isSelected ? 'rgba(229, 9, 20, 0.4)' : 'rgba(255, 255, 255, 0.08)'}`,
                      color: isSelected ? '#ffffff' : '#cbd5e1',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>
                        {s.label || `Server ${idx + 1}`}
                      </span>
                      <span style={{ fontSize: '0.72rem', backgroundColor: 'rgba(255,255,255,0.08)', padding: '2px 6px', borderRadius: '4px' }}>
                        {s.quality || '1080p'}
                      </span>
                    </div>
                    {isSelected && <Check size={16} color="#ef4444" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Episode Drawer (TV Shows) */}
      {showEpisodeDrawer && mediaType === 'tv' && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.65)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          justifyContent: 'flex-end',
          zIndex: 60
        }}>
          <div style={{
            width: '100%',
            maxWidth: '380px',
            height: '100%',
            backgroundColor: '#121217',
            borderLeft: '1px solid rgba(255, 255, 255, 0.1)',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>Episodes - Season {season}</h3>
              <button onClick={() => setShowEpisodeDrawer(false)} className="untitledui-btn">
                <X size={18} />
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {Array.from({ length: 24 }).map((_, idx) => {
                const epNum = idx + 1;
                const isCurrent = Number(episode) === epNum;
                return (
                  <a
                    key={epNum}
                    href={`/tv/${mediaId}/${season}/${epNum}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      backgroundColor: isCurrent ? 'rgba(229, 9, 20, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                      border: `1px solid ${isCurrent ? 'rgba(229, 9, 20, 0.4)' : 'rgba(255, 255, 255, 0.06)'}`,
                      color: isCurrent ? '#ffffff' : '#94a3b8',
                      fontSize: '0.86rem',
                      fontWeight: isCurrent ? 700 : 500
                    }}
                  >
                    <span>Episode {epNum}</span>
                    {isCurrent && <span style={{ color: '#ef4444', fontSize: '0.74rem' }}>Watching</span>}
                  </a>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
