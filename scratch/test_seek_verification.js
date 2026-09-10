const assert = require('assert');
const { prioritizeTorrentWindow } = require('../src/torrentManager');

console.log('Testing prioritizeTorrentWindow seek pruning...');

// Mock wire with requests
let cancelledBlocks = [];
const mockWire = {
  requests: [
    { piece: 1, offset: 0, length: 16384 },
    { piece: 5, offset: 0, length: 16384 },
    { piece: 10, offset: 0, length: 16384 },
    { piece: 50, offset: 0, length: 16384 }
  ],
  cancel: (piece, offset, length) => {
    cancelledBlocks.push({ piece, offset, length });
  }
};

const mockTorrent = {
  pieces: new Array(100).fill(null),
  wires: [mockWire],
  _selections: {
    _items: [
      { from: 0, to: 3, priority: 5 },
      { from: 4, to: 20, priority: 5 },
      { from: 97, to: 99, priority: 5 }
    ]
  },
  _critical: new Array(100).fill(false),
  critical: function(start, end) {
    for (let i = start; i <= end; i++) this._critical[i] = true;
  },
  select: function(start, end, priority) {
    this._selections._items.push({ from: start, to: end, priority });
  },
  deselect: function(start, end) {},
  _update: function() { this.updated = true; }
};

// Initial state: pieces 0..10 are critical
for (let i = 0; i <= 10; i++) mockTorrent._critical[i] = true;

const torrentData = {
  torrent: mockTorrent,
  file: { _startPiece: 0, _endPiece: 99 },
  lastBufferedPiece: 5
};

// Jump far ahead to piece 50!
prioritizeTorrentWindow(torrentData, 50, 10, 25);

console.log('Cancelled blocks:', cancelledBlocks);
// Pieces 5 and 10 should be cancelled (not header 0..3, and not window 50..75)
assert(cancelledBlocks.some(b => b.piece === 5), 'Piece 5 should be cancelled');
assert(cancelledBlocks.some(b => b.piece === 10), 'Piece 10 should be cancelled');
assert(!cancelledBlocks.some(b => b.piece === 1), 'Header piece 1 should NOT be cancelled');
assert(!cancelledBlocks.some(b => b.piece === 50), 'Seek piece 50 should NOT be cancelled');

// Critical flags check
assert(mockTorrent._critical[50] === true, 'Seek piece 50 must be critical');
assert(mockTorrent._critical[5] === false, 'Old piece 5 must NOT be critical');
assert(mockTorrent._critical[10] === false, 'Old piece 10 must NOT be critical');
assert(mockTorrent._critical[0] === true, 'Header piece 0 must remain critical');

// Selections check
const hasOldMidSelection = mockTorrent._selections._items.some(item => item.from === 4 && item.to === 20);
assert(!hasOldMidSelection, 'Old intermediate selection 4..20 must be pruned');

console.log('ALL PRIORITIZE TESTS PASSED!');
