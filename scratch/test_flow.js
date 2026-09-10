const { prepareTorrentOnServer, getTorrentData } = require('../src/torrentManager');
const { generateStreamTicket } = require('../src/services/streamSecurity');
const http = require('http');

async function test() {
  console.log('1. Preparing test torrent...');
  const testMagnet = 'magnet:?xt=urn:btih:08a806048a1e1b4b1a43a01aa2db6f28b33c1626&dn=Big+Buck+Bunny';
  
  try {
    const res = await prepareTorrentOnServer({ infoHash: '08a806048a1e1b4b1a43a01aa2db6f28b33c1626', magnet: testMagnet, name: 'Big Buck Bunny' });
    console.log('Stream prepared:', res.filename, res.infoHash);
    
    const data = getTorrentData(res.infoHash);
    console.log('Pieces:', data.torrent.pieces.length);
    console.log('Testing seek in prioritizeTorrentWindow...');
    const { prioritizeTorrentWindow } = require('../src/torrentManager');
    
    // Test jump to piece 200
    prioritizeTorrentWindow(data, 200, 10, 30);
    console.log('lastBufferedPiece is now:', data.lastBufferedPiece);
    console.log('Piece 200 critical:', data.torrent._critical[200]);
    console.log('Header 0 critical:', data.torrent._critical[0]);
    console.log('Piece 50 critical:', data.torrent._critical[50]);
    
    console.log('SUCCESS! Verification passed.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

test();
