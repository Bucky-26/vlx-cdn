import React, { useState, useEffect } from 'react';
import Navbar from './components/Navbar';
import AdminDashboard from './components/Admin/AdminDashboard';
import VideoPlayer from './components/Player/VideoPlayer';
import { Shield, Film } from 'lucide-react';

export default function App() {
  const [currentPath, setCurrentPath] = useState(window.location.pathname);

  // Synchronize on browser forward/back buttons
  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(window.location.pathname);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = (path) => {
    window.history.pushState({}, '', path);
    setCurrentPath(path);
  };

  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigate('/admin');
    }
  };

  // Route parser
  const movieMatch = currentPath.match(/^\/movie\/([0-9]+)/i);
  const tvMatch = currentPath.match(/^\/tv\/([0-9]+)\/([0-9]+)(?:\/(?:epesode\/)?([0-9]+))?/i);
  const isAdmin = currentPath.startsWith('/admin');

  // Video Player View (Movie)
  if (movieMatch) {
    const tmdbId = movieMatch[1];
    return (
      <VideoPlayer 
        mediaId={tmdbId} 
        mediaType="movie" 
        onBack={handleBack} 
      />
    );
  }

  // Video Player View (TV)
  if (tvMatch) {
    const tmdbId = tvMatch[1];
    const season = tvMatch[2];
    const episode = tvMatch[3] || 1;
    return (
      <VideoPlayer 
        mediaId={tmdbId} 
        mediaType="tv" 
        season={season} 
        episode={episode} 
        onBack={handleBack} 
      />
    );
  }

  // Admin View
  if (isAdmin) {
    return (
      <div style={{ minHeight: '100vh', backgroundColor: '#09090c' }}>
        <Navbar 
          currentView="admin" 
          onNavigate={navigate} 
        />
        <main>
          <AdminDashboard />
        </main>
      </div>
    );
  }

  // Root / or other routes: Direct Embed Player info
  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#09090c',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      color: '#ffffff'
    }}>
      <div className="glass-panel" style={{
        maxWidth: '460px',
        width: '100%',
        padding: '36px 32px',
        textAlign: 'center',
        borderRadius: '16px',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 20px 50px rgba(0,0,0,0.8)'
      }}>
        <div style={{
          width: '56px',
          height: '56px',
          borderRadius: '50%',
          backgroundColor: 'rgba(229, 9, 20, 0.15)',
          border: '1px solid rgba(229, 9, 20, 0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 20px',
          boxShadow: '0 0 20px rgba(229, 9, 20, 0.3)'
        }}>
          <Film size={26} color="#e50914" />
        </div>

        <h2 style={{ fontSize: '1.45rem', fontWeight: 800, marginBottom: '8px' }}>
          Direct Embed Player
        </h2>
        <p style={{ color: '#94a3b8', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '24px' }}>
          This server is configured as a dedicated CDN streaming node. Playback must be accessed directly via:
        </p>

        <div style={{
          backgroundColor: 'rgba(0, 0, 0, 0.4)',
          padding: '14px',
          borderRadius: '8px',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          fontFamily: 'monospace',
          fontSize: '0.84rem',
          color: '#e2e8f0',
          textAlign: 'left',
          marginBottom: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}>
          <div><span style={{ color: '#e50914' }}>GET</span> /movie/:tmdbId</div>
          <div><span style={{ color: '#e50914' }}>GET</span> /tv/:tmdbId/:season/:episode</div>
        </div>

        <button
          onClick={() => navigate('/admin')}
          className="btn-crimson"
          style={{
            width: '100%',
            padding: '10px 18px',
            fontSize: '0.9rem',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px'
          }}
        >
          <Shield size={16} /> Open Admin Control Center
        </button>
      </div>
    </div>
  );
}
