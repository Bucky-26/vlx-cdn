import React, { useState, useEffect } from 'react';
import { 
  Activity, Server, Database, Plus, Trash2, RefreshCw, 
  CheckCircle, AlertCircle, HardDrive, Wifi, ShieldCheck, Film, Magnet,
  Lock, Eye, EyeOff, LogOut, Key, ArrowRight, Mail, UserPlus, UserCheck
} from 'lucide-react';

export default function AdminDashboard() {
  // Authentication State (Supabase Auth)
  const [authToken, setAuthToken] = useState(() => {
    return sessionStorage.getItem('viewlix_admin_token') || localStorage.getItem('viewlix_admin_token') || '';
  });
  const [adminEmail, setAdminEmail] = useState(() => {
    return sessionStorage.getItem('viewlix_admin_email') || localStorage.getItem('viewlix_admin_email') || '';
  });
  const [isAuthenticated, setIsAuthenticated] = useState(Boolean(authToken));
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState(null);

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Custom Source Form State
  const [tmdbId, setTmdbId] = useState('');
  const [mediaType, setMediaType] = useState('movie');
  const [season, setSeason] = useState('');
  const [episode, setEpisode] = useState('');
  const [title, setTitle] = useState('');
  const [magnetUrl, setMagnetUrl] = useState('');
  const [infoHash, setInfoHash] = useState('');
  const [quality, setQuality] = useState('1080p');
  const [priority, setPriority] = useState('10');
  const [savingSource, setSavingSource] = useState(false);
  const [sourceNotice, setSourceNotice] = useState(null);

  // Existing Sources Query State
  const [queryTmdbId, setQueryTmdbId] = useState('');
  const [queriedSources, setQueriedSources] = useState([]);

  // Authenticated fetch wrapper
  const adminFetch = async (url, options = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
      'x-admin-key': authToken
    };
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      handleLogout();
      throw new Error('Admin session unauthorized or expired.');
    }
    return res;
  };

  // Supabase Auth Login
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    if (!loginPassword.trim()) {
      setLoginError('Please enter your password.');
      return;
    }

    setLoginLoading(true);
    setLoginError(null);

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: loginEmail.trim(),
          password: loginPassword.trim()
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Authentication failed');
      }

      const key = data.token;
      const userEmail = data.user?.email || loginEmail.trim() || 'admin@viewlix.site';
      sessionStorage.setItem('viewlix_admin_token', key);
      localStorage.setItem('viewlix_admin_token', key);
      sessionStorage.setItem('viewlix_admin_email', userEmail);
      localStorage.setItem('viewlix_admin_email', userEmail);
      setAuthToken(key);
      setAdminEmail(userEmail);
      setIsAuthenticated(true);
      setLoginPassword('');
    } catch (err) {
      setLoginError(err.message);
    } finally {
      setLoginLoading(false);
    }
  };

  // Logout handler
  const handleLogout = () => {
    sessionStorage.removeItem('viewlix_admin_token');
    localStorage.removeItem('viewlix_admin_token');
    sessionStorage.removeItem('viewlix_admin_email');
    localStorage.removeItem('viewlix_admin_email');
    setAuthToken('');
    setAdminEmail('');
    setIsAuthenticated(false);
    setStatus(null);
  };

  // Fetch status from Express API
  const fetchStatus = async () => {
    if (!authToken) return;
    try {
      setLoading(true);
      const res = await adminFetch('/api/admin/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated && authToken) {
      fetchStatus();
      const interval = setInterval(fetchStatus, 5000);
      return () => clearInterval(interval);
    }
  }, [isAuthenticated, authToken]);

  // Parse magnet link utility
  const handleParseMagnet = async () => {
    if (!magnetUrl.startsWith('magnet:?')) return;
    try {
      const res = await adminFetch('/api/admin/parse-magnet', {
        method: 'POST',
        body: JSON.stringify({ magnetUrl })
      });
      const data = await res.json();
      if (data.infoHash) {
        setInfoHash(data.infoHash);
        if (data.displayName && !title) setTitle(data.displayName);
      }
    } catch (e) {}
  };

  // Add source to Supabase
  const handleAddSource = async (e) => {
    e.preventDefault();
    if (!tmdbId || (!magnetUrl && !infoHash)) {
      setSourceNotice({ type: 'error', text: 'TMDB ID and Magnet or InfoHash are required' });
      return;
    }

    setSavingSource(true);
    setSourceNotice(null);

    try {
      const res = await adminFetch('/api/admin/sources', {
        method: 'POST',
        body: JSON.stringify({
          tmdbId,
          mediaType,
          season: season ? Number(season) : null,
          episode: episode ? Number(episode) : null,
          title,
          magnetUrl,
          infoHash,
          quality,
          priority: Number(priority)
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to save source');
      }

      setSourceNotice({ type: 'success', text: `Source saved to Supabase (Hash: ${infoHash || data.data?.info_hash})` });
      setMagnetUrl('');
      setInfoHash('');
      setTitle('');
    } catch (err) {
      setSourceNotice({ type: 'error', text: err.message });
    } finally {
      setSavingSource(false);
    }
  };

  // Query sources for a TMDB ID
  const handleQuerySources = async (e) => {
    e?.preventDefault();
    if (!queryTmdbId) return;

    try {
      const res = await adminFetch(`/api/admin/sources/${queryTmdbId}?mediaType=movie`);
      const data = await res.json();
      setQueriedSources(data.sources || []);
    } catch (err) {
      console.error(err);
    }
  };

  // Delete a source from Supabase
  const handleDeleteSource = async (id) => {
    try {
      const res = await adminFetch(`/api/admin/sources/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setQueriedSources(prev => prev.filter(s => s.id !== id));
      }
    } catch (e) {}
  };

  // Forcibly remove a torrent from memory and storage
  const handleRemoveTorrent = async (infoHash) => {
    try {
      const res = await adminFetch('/api/admin/torrents/remove', {
        method: 'POST',
        body: JSON.stringify({ infoHash })
      });
      if (res.ok) {
        fetchStatus();
      }
    } catch (e) {}
  };

  // Purge all idle/unused torrents with 0 readers
  const handlePurgeIdleTorrents = async () => {
    try {
      const res = await adminFetch('/api/admin/torrents/purge-idle', { method: 'POST' });
      if (res.ok) {
        fetchStatus();
      }
    } catch (e) {}
  };

  // ── Render Admin Login if Unauthenticated ──────────────────────────────────
  if (!isAuthenticated) {
    return (
      <div style={{
        minHeight: 'calc(100vh - 70px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px'
      }}>
        <div className="glass-panel" style={{
          maxWidth: '430px',
          width: '100%',
          padding: '36px 30px',
          borderRadius: '16px',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.85)'
        }}>
          {/* Badge Icon */}
          <div style={{
            width: '54px',
            height: '54px',
            borderRadius: '14px',
            backgroundColor: 'rgba(229, 9, 20, 0.15)',
            border: '1px solid rgba(229, 9, 20, 0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
            boxShadow: '0 0 24px rgba(229, 9, 20, 0.25)'
          }}>
            <Database size={24} color="#e50914" />
          </div>

          <h2 style={{
            fontSize: '1.4rem',
            fontWeight: 800,
            textAlign: 'center',
            marginBottom: '6px',
            color: '#ffffff'
          }}>
            Admin Control Center
          </h2>
          <p style={{
            fontSize: '0.86rem',
            color: '#94a3b8',
            textAlign: 'center',
            lineHeight: 1.5,
            marginBottom: '22px'
          }}>
            Authenticate via Supabase Auth to manage video streaming nodes and database sources.
          </p>

          {loginError && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              backgroundColor: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '8px',
              padding: '10px 14px',
              marginBottom: '20px',
              color: '#f87171',
              fontSize: '0.84rem'
            }}>
              <AlertCircle size={15} style={{ flexShrink: 0 }} />
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleAuthSubmit}>
            <div style={{ marginBottom: '16px' }}>
              <label style={{
                display: 'block',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: '#cbd5e1',
                marginBottom: '6px'
              }}>
                Admin Email
              </label>
              <div style={{ position: 'relative' }}>
                <input 
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="admin@viewlix.site"
                  autoFocus
                  style={{
                    width: '100%',
                    backgroundColor: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    borderRadius: '8px',
                    padding: '9px 14px 9px 38px',
                    color: '#ffffff',
                    fontSize: '0.9rem',
                    outline: 'none',
                    transition: 'border-color 0.2s',
                    boxSizing: 'border-box'
                  }}
                  onFocus={(e) => e.target.style.borderColor = '#e50914'}
                  onBlur={(e) => e.target.style.borderColor = 'rgba(255, 255, 255, 0.15)'}
                />
                <Mail 
                  size={15} 
                  color="#94a3b8" 
                  style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} 
                />
              </div>
            </div>

            <div style={{ marginBottom: '22px' }}>
              <label style={{
                display: 'block',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: '#cbd5e1',
                marginBottom: '6px'
              }}>
                Password
              </label>
              <div style={{ position: 'relative' }}>
                <input 
                  type={showPassword ? "text" : "password"}
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="Enter password"
                  style={{
                    width: '100%',
                    backgroundColor: 'rgba(255, 255, 255, 0.06)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    borderRadius: '8px',
                    padding: '9px 40px 9px 38px',
                    color: '#ffffff',
                    fontSize: '0.9rem',
                    outline: 'none',
                    transition: 'border-color 0.2s',
                    boxSizing: 'border-box'
                  }}
                  onFocus={(e) => e.target.style.borderColor = '#e50914'}
                  onBlur={(e) => e.target.style.borderColor = 'rgba(255, 255, 255, 0.15)'}
                />
                <Lock 
                  size={15} 
                  color="#94a3b8" 
                  style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} 
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute',
                    right: '12px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: '#94a3b8',
                    cursor: 'pointer',
                    padding: '2px',
                    display: 'flex',
                    alignItems: 'center'
                  }}
                  title={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loginLoading}
              className="btn-crimson"
              style={{
                width: '100%',
                padding: '11px',
                fontSize: '0.9rem',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                opacity: loginLoading ? 0.7 : 1,
                cursor: loginLoading ? 'not-allowed' : 'pointer'
              }}
            >
              {loginLoading ? (
                <span>Authenticating with Supabase...</span>
              ) : (
                <>
                  <Database size={16} /> Sign In with Supabase
                </>
              )}
            </button>
          </form>

          <div style={{
            marginTop: '18px',
            textAlign: 'center',
            fontSize: '0.74rem',
            color: '#64748b'
          }}>
            Secured with Supabase Auth (PostgreSQL)
          </div>
        </div>
      </div>
    );
  }

  // ── Render Authenticated Admin Dashboard ───────────────────────────────────
  return (
    <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '32px 24px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <ShieldCheck size={24} color="#e50914" />
            <h1 style={{ fontSize: '1.75rem', fontWeight: 800 }}>Viewlix Admin Control Center</h1>
          </div>
          <p style={{ color: '#94a3b8', fontSize: '0.88rem' }}>
            Monitor streaming nodes, manage Supabase database overrides, and inspect WebTorrent swarms.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {/* Supabase User Pill */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            border: '1px solid rgba(34, 197, 94, 0.3)',
            borderRadius: '20px',
            padding: '6px 12px',
            fontSize: '0.8rem',
            color: '#4ade80'
          }}>
            <UserCheck size={14} />
            <span>{adminEmail || 'admin@viewlix.site'}</span>
          </div>

          <button 
            onClick={fetchStatus} 
            className="btn-secondary" 
            style={{ padding: '8px 14px', fontSize: '0.84rem' }}
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button 
            onClick={handleLogout} 
            className="btn-secondary" 
            style={{
              padding: '8px 14px',
              fontSize: '0.84rem',
              color: '#f87171',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              backgroundColor: 'rgba(239, 68, 68, 0.08)'
            }}
            title="Log out of Admin"
          >
            <LogOut size={14} /> Logout
          </button>
        </div>
      </div>

      {/* Metrics Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '32px' }}>
        {/* Supabase Status */}
        <div className="glass-panel" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ fontSize: '0.84rem', color: '#94a3b8', fontWeight: 600 }}>DATABASE STATUS</span>
            <Database size={18} color="#e50914" />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {status?.supabaseConfigured ? (
              <>
                <CheckCircle size={20} color="#22c55e" />
                <span style={{ fontWeight: 700, fontSize: '1.1rem', color: '#22c55e' }}>Supabase Connected</span>
              </>
            ) : (
              <>
                <AlertCircle size={20} color="#f59e0b" />
                <span style={{ fontWeight: 700, fontSize: '1.1rem', color: '#f59e0b' }}>Offline / Local Mock</span>
              </>
            )}
          </div>
          <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '6px' }}>
            {status?.supabaseConfigured ? 'PostgreSQL ready for sources & history' : 'Add SUPABASE_URL & KEY to .env'}
          </div>
        </div>

        {/* Active Swarms */}
        <div className="glass-panel" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ fontSize: '0.84rem', color: '#94a3b8', fontWeight: 600 }}>ACTIVE TORRENTS</span>
            <Wifi size={18} color="#e50914" />
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>
            {status?.torrentClient?.activeSwarmCount || 0}
          </div>
          <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '4px' }}>
            ↓ {status?.torrentClient?.downloadSpeedKb || 0} KB/s  •  ↑ {status?.torrentClient?.uploadSpeedKb || 0} KB/s
          </div>
        </div>

        {/* Server Memory */}
        <div className="glass-panel" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ fontSize: '0.84rem', color: '#94a3b8', fontWeight: 600 }}>NODE MEMORY (RSS)</span>
            <HardDrive size={18} color="#e50914" />
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>
            {status?.system?.processMemoryMb || 0} MB
          </div>
          <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '4px' }}>
            Free: {status?.system?.freeMemoryMb || 0} MB / {status?.system?.totalMemoryMb || 0} MB
          </div>
        </div>

        {/* Uptime */}
        <div className="glass-panel" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ fontSize: '0.84rem', color: '#94a3b8', fontWeight: 600 }}>STREAMER UPTIME</span>
            <Server size={18} color="#e50914" />
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>
            {status?.uptimeSeconds ? `${Math.floor(status.uptimeSeconds / 60)}m ${status.uptimeSeconds % 60}s` : '—'}
          </div>
          <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: '4px' }}>
            Platform: {status?.system?.platform || 'windows'} ({status?.system?.cpuCount || 4} CPUs)
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '24px' }}>
        {/* Left Column: Add / Override Source in Supabase */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Magnet size={18} color="#e50914" />
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700 }}>Pin / Override Torrent Source</h2>
          </div>
          <p style={{ color: '#94a3b8', fontSize: '0.82rem', marginBottom: '20px' }}>
            Force a specific magnet link or infoHash to be used for a movie or TV episode instead of scraped results.
          </p>

          {sourceNotice && (
            <div style={{
              padding: '10px 14px',
              borderRadius: '8px',
              marginBottom: '16px',
              fontSize: '0.84rem',
              backgroundColor: sourceNotice.type === 'success' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
              color: sourceNotice.type === 'success' ? '#4ade80' : '#f87171',
              border: `1px solid ${sourceNotice.type === 'success' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`
            }}>
              {sourceNotice.text}
            </div>
          )}

          <form onSubmit={handleAddSource} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>TMDB ID *</label>
                <input
                  type="text"
                  placeholder="e.g. 24428"
                  value={tmdbId}
                  onChange={(e) => setTmdbId(e.target.value)}
                  style={{
                    width: '100%',
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: '6px',
                    padding: '8px 10px',
                    fontSize: '0.86rem'
                  }}
                  required
                />
              </div>
              <div>
                <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Media Type</label>
                <select
                  value={mediaType}
                  onChange={(e) => setMediaType(e.target.value)}
                  style={{
                    width: '100%',
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: '6px',
                    padding: '8px 10px',
                    fontSize: '0.86rem'
                  }}
                >
                  <option value="movie">Movie</option>
                  <option value="tv">TV Episode</option>
                </select>
              </div>
            </div>

            {mediaType === 'tv' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Season</label>
                  <input
                    type="number"
                    placeholder="1"
                    value={season}
                    onChange={(e) => setSeason(e.target.value)}
                    style={{
                      width: '100%',
                      backgroundColor: 'rgba(255,255,255,0.06)',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.15)',
                      borderRadius: '6px',
                      padding: '8px 10px',
                      fontSize: '0.86rem'
                    }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Episode</label>
                  <input
                    type="number"
                    placeholder="1"
                    value={episode}
                    onChange={(e) => setEpisode(e.target.value)}
                    style={{
                      width: '100%',
                      backgroundColor: 'rgba(255,255,255,0.06)',
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.15)',
                      borderRadius: '6px',
                      padding: '8px 10px',
                      fontSize: '0.86rem'
                    }}
                  />
                </div>
              </div>
            )}

            <div>
              <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Magnet URL or Torrent Hash *</label>
              <textarea
                placeholder="magnet:?xt=urn:btih:... or 40-char infoHash"
                value={magnetUrl}
                onChange={(e) => setMagnetUrl(e.target.value)}
                onBlur={handleParseMagnet}
                rows={3}
                style={{
                  width: '100%',
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  color: '#fff',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '0.82rem',
                  fontFamily: 'monospace'
                }}
                required
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Quality Badge</label>
                <select
                  value={quality}
                  onChange={(e) => setQuality(e.target.value)}
                  style={{
                    width: '100%',
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: '6px',
                    padding: '8px 10px',
                    fontSize: '0.86rem'
                  }}
                >
                  <option value="4K">4K Ultra HD</option>
                  <option value="1080p">1080p FHD</option>
                  <option value="720p">720p HD</option>
                  <option value="480p">480p SD</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: '0.78rem', color: '#94a3b8', display: 'block', marginBottom: '4px' }}>Priority</label>
                <input
                  type="number"
                  placeholder="10"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  style={{
                    width: '100%',
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: '6px',
                    padding: '8px 10px',
                    fontSize: '0.86rem'
                  }}
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={savingSource}
              className="btn-crimson"
              style={{ marginTop: '8px', padding: '10px 16px' }}
            >
              <Plus size={16} /> {savingSource ? 'Saving to Supabase...' : 'Save & Pin Source'}
            </button>
          </form>
        </div>

        {/* Right Column: Active Torrent Swarms */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Activity size={18} color="#e50914" />
              <h2 style={{ fontSize: '1.15rem', fontWeight: 700 }}>Active WebTorrent Swarms</h2>
            </div>
            {status?.torrentClient?.torrents?.length > 0 && (
              <button
                onClick={handlePurgeIdleTorrents}
                className="btn-secondary"
                style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                title="Remove any torrents with 0 active readers"
              >
                Purge Unused
              </button>
            )}
          </div>

          {status?.torrentClient?.torrents?.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: '#64748b' }}>
              No active torrent streams at the moment.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {status?.torrentClient?.torrents?.map((t, idx) => (
                <div key={idx} style={{
                  padding: '12px',
                  backgroundColor: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '8px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
                    <div style={{ fontWeight: 600, fontSize: '0.88rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>
                      {t.name || t.infoHash}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                      {t.activeReaders > 0 ? (
                        <span style={{ backgroundColor: 'rgba(34, 197, 94, 0.15)', color: '#4ade80', fontSize: '0.72rem', padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>
                          In Use ({t.activeReaders} {t.activeReaders === 1 ? 'tab' : 'tabs'})
                        </span>
                      ) : (
                        <span style={{ backgroundColor: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', fontSize: '0.72rem', padding: '2px 6px', borderRadius: '4px', fontWeight: 600 }}>
                          Idle ({t.idleSeconds}s)
                        </span>
                      )}
                      <button
                        onClick={() => handleRemoveTorrent(t.infoHash)}
                        title="Remove swarm now"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#f87171',
                          cursor: 'pointer',
                          padding: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          borderRadius: '4px'
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: '#94a3b8', marginBottom: '6px' }}>
                    <span>{t.numPeers} peers • ↓ {t.downloadSpeedKb} KB/s</span>
                    <span>{t.progress}% ({t.downloadedMb} / {t.totalMb} MB)</span>
                  </div>
                  <div style={{ width: '100%', height: '4px', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden' }}>
                    <div style={{ width: `${t.progress}%`, height: '100%', backgroundColor: '#e50914' }}></div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
