import React, { useState, useEffect } from 'react';
import { Play, Clock, Sparkles, Film, Tv, ArrowRight } from 'lucide-react';
import { getWatchHistory } from '../../services/supabaseClient';

const FEATURED_ITEMS = [
  { id: '24428', type: 'movie', title: 'The Avengers', year: '2012', quality: '1080p', poster: 'https://image.tmdb.org/t/p/w500/RYMX2wcKCBAr24UyPD7xwmjaTn.jpg', backdrop: 'https://image.tmdb.org/t/p/original/9BBTo63ANSmAgaxPD0r6p6xgY2d.jpg' },
  { id: '157336', type: 'movie', title: 'Interstellar', year: '2014', quality: '1080p', poster: 'https://image.tmdb.org/t/p/w500/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg', backdrop: 'https://image.tmdb.org/t/p/original/xJHokMbljvjADYdit5fK5VQsXEG.jpg' },
  { id: '693134', type: 'movie', title: 'Dune: Part Two', year: '2024', quality: '4K', poster: 'https://image.tmdb.org/t/p/w500/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg', backdrop: 'https://image.tmdb.org/t/p/original/xOMo8BRK7PfcJv9JCnx7s5200bm.jpg' },
  { id: '1399', type: 'tv', season: 1, episode: 1, title: 'Game of Thrones', year: '2011', quality: '1080p', poster: 'https://image.tmdb.org/t/p/w500/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg', backdrop: 'https://image.tmdb.org/t/p/original/2OMB0ynKlyIenMJWI2Dy9IWT4c.jpg' },
  { id: '66732', type: 'tv', season: 1, episode: 1, title: 'Stranger Things', year: '2016', quality: '1080p', poster: 'https://image.tmdb.org/t/p/w500/49WJfeN0moxb9IPfGn8AIqMGskD.jpg', backdrop: 'https://image.tmdb.org/t/p/original/56v2KjBlU4XaOv9rVYEQypROD7P.jpg' },
  { id: '1396', type: 'tv', season: 1, episode: 1, title: 'Breaking Bad', year: '2008', quality: '1080p', poster: 'https://image.tmdb.org/t/p/w500/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg', backdrop: 'https://image.tmdb.org/t/p/original/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg' }
];

export default function Catalog({ onPlay }) {
  const [history, setHistory] = useState([]);
  const [activeTab, setActiveTab] = useState('all');

  useEffect(() => {
    async function loadHistory() {
      const items = await getWatchHistory();
      setHistory(items);
    }
    loadHistory();
  }, []);

  const filteredItems = FEATURED_ITEMS.filter(item => {
    if (activeTab === 'all') return true;
    return item.type === activeTab;
  });

  return (
    <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '32px 24px' }}>
      {/* Hero Banner */}
      <div 
        className="glass-panel"
        style={{
          position: 'relative',
          borderRadius: '16px',
          overflow: 'hidden',
          padding: '48px 36px',
          marginBottom: '40px',
          backgroundImage: `linear-gradient(to right, rgba(9, 9, 12, 0.95) 30%, rgba(9, 9, 12, 0.4) 100%), url(${FEATURED_ITEMS[0].backdrop})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center'
        }}
      >
        <div style={{ maxWidth: '600px' }}>
          <div style={{ 
            display: 'inline-flex', 
            alignItems: 'center', 
            gap: '6px', 
            backgroundColor: 'rgba(229, 9, 20, 0.2)', 
            color: '#e50914', 
            padding: '4px 12px', 
            borderRadius: '20px', 
            fontSize: '0.8rem', 
            fontWeight: 700, 
            marginBottom: '16px' 
          }}>
            <Sparkles size={14} /> CINEMATIC PEER-TO-PEER STREAMING
          </div>
          <h1 style={{ fontSize: '2.5rem', fontWeight: 800, marginBottom: '12px', lineHeight: 1.15 }}>
            Instant WebTorrent Player
          </h1>
          <p style={{ color: '#cbd5e1', fontSize: '1rem', lineHeight: 1.6, marginBottom: '24px' }}>
            Direct in-browser streaming with adaptive piece prioritization, on-the-fly audio transcoding, and Supabase cloud persistence.
          </p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={() => onPlay(FEATURED_ITEMS[0])}
              className="btn-crimson"
              style={{ padding: '12px 24px', fontSize: '1rem' }}
            >
              <Play size={18} fill="#ffffff" /> Stream The Avengers
            </button>
          </div>
        </div>
      </div>

      {/* Continue Watching Section (Supabase / LocalStorage Sync) */}
      {history.length > 0 && (
        <section style={{ marginBottom: '40px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
            <Clock size={20} color="#e50914" />
            <h2 style={{ fontSize: '1.35rem', fontWeight: 700 }}>Continue Watching</h2>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '16px' }}>
            {history.map((h, idx) => {
              const pct = h.duration_seconds > 0 ? Math.min(100, Math.round((h.progress_seconds / h.duration_seconds) * 100)) : 0;
              return (
                <div 
                  key={idx}
                  onClick={() => onPlay({
                    id: h.tmdb_id,
                    type: h.media_type,
                    season: h.season,
                    episode: h.episode
                  })}
                  className="glass-panel"
                  style={{
                    padding: '12px',
                    cursor: 'pointer',
                    transition: 'transform 0.2s ease, border-color 0.2s ease'
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.borderColor = '#e50914'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)'; }}
                >
                  <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {h.title || `Media #${h.tmdb_id}`}
                  </div>
                  <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginBottom: '10px' }}>
                    {h.media_type === 'tv' ? `S${h.season}E${h.episode}` : 'Movie'} • {Math.floor(h.progress_seconds / 60)}m left
                  </div>
                  {/* Progress Bar */}
                  <div style={{ width: '100%', height: '4px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', backgroundColor: '#e50914' }}></div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Catalog Grid */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Featured Movies & Series</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            {['all', 'movie', 'tv'].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '20px',
                  fontSize: '0.84rem',
                  fontWeight: 600,
                  backgroundColor: activeTab === tab ? '#e50914' : 'rgba(255,255,255,0.06)',
                  color: activeTab === tab ? '#ffffff' : '#94a3b8',
                  transition: 'all 0.2s ease'
                }}
              >
                {tab === 'all' ? 'All' : tab === 'movie' ? 'Movies' : 'TV Shows'}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '20px' }}>
          {filteredItems.map((item) => (
            <div
              key={item.id}
              onClick={() => onPlay(item)}
              style={{
                cursor: 'pointer',
                transition: 'transform 0.2s ease'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.03)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
            >
              <div style={{
                position: 'relative',
                borderRadius: '10px',
                overflow: 'hidden',
                aspectRatio: '2/3',
                backgroundColor: '#121217',
                marginBottom: '10px'
              }}>
                <img 
                  src={item.poster} 
                  alt={item.title}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
                <span style={{
                  position: 'absolute',
                  top: '8px',
                  right: '8px',
                  backgroundColor: 'rgba(229, 9, 20, 0.85)',
                  color: '#fff',
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: '4px'
                }}>
                  {item.quality}
                </span>
              </div>
              <div style={{ fontWeight: 600, fontSize: '0.92rem', color: '#f8fafc', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {item.title}
              </div>
              <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                {item.year} • {item.type === 'movie' ? 'Movie' : `S${item.season} E${item.episode}`}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
