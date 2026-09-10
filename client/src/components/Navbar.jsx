import React, { useState } from 'react';
import { Film, Tv, Shield, Play, Search } from 'lucide-react';

export default function Navbar({ currentView, onNavigate }) {
  const [quickId, setQuickId] = useState('');
  const [quickType, setQuickType] = useState('movie');

  const handleQuickPlay = (e) => {
    e.preventDefault();
    if (!quickId.trim()) return;
    if (quickType === 'movie') {
      onNavigate(`/movie/${quickId.trim()}`);
    } else {
      onNavigate(`/tv/${quickId.trim()}/1/1`);
    }
  };

  return (
    <header style={{
      position: 'sticky',
      top: 0,
      zIndex: 100,
      backgroundColor: 'rgba(9, 9, 12, 0.85)',
      backdropFilter: 'blur(16px)',
      borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
      padding: '12px 24px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '16px'
    }}>
      {/* Brand */}
      <div 
        onClick={() => onNavigate('/admin')}
        style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
        title="Viewlix Admin"
      >
        <img 
          src="/images/logo.png" 
          onError={(e) => { e.target.src = 'https://viewlix.site/logo.png'; }}
          alt="Viewlix" 
          className="brand-logo-img" 
        />
        <span style={{ 
          fontSize: '1.25rem', 
          fontWeight: 900, 
          letterSpacing: '2px', 
          color: '#ffffff' 
        }}>
          VIEW<span style={{ color: '#e50914' }}>LIX</span>
        </span>
      </div>

      {/* Nav Links */}
      <nav style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <button
          onClick={() => onNavigate('/admin')}
          style={{
            backgroundColor: 'rgba(229, 9, 20, 0.2)',
            color: '#e50914',
            border: '1px solid #e50914',
            padding: '6px 14px',
            borderRadius: '20px',
            fontWeight: 600,
            fontSize: '0.86rem',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
        >
          <Shield size={14} /> Admin Panel
        </button>
      </nav>

      {/* Quick Stream Launch Form */}
      <form onSubmit={handleQuickPlay} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <select
          value={quickType}
          onChange={(e) => setQuickType(e.target.value)}
          style={{
            backgroundColor: 'rgba(255, 255, 255, 0.08)',
            color: '#f8fafc',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '6px',
            padding: '6px 8px',
            fontSize: '0.82rem',
            outline: 'none'
          }}
        >
          <option value="movie">Movie</option>
          <option value="tv">TV Show</option>
        </select>
        <input
          type="text"
          placeholder="TMDB ID (e.g. 24428)"
          value={quickId}
          onChange={(e) => setQuickId(e.target.value)}
          style={{
            backgroundColor: 'rgba(255, 255, 255, 0.06)',
            color: '#ffffff',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '6px',
            padding: '6px 12px',
            fontSize: '0.84rem',
            width: '140px',
            outline: 'none'
          }}
        />
        <button 
          type="submit" 
          className="btn-crimson" 
          style={{ padding: '6px 12px', fontSize: '0.82rem' }}
          title="Play Stream"
        >
          <Play size={13} /> Play
        </button>
      </form>
    </header>
  );
}
