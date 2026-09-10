const http = require('http');
const { generateStreamTicket } = require('../src/services/streamSecurity');

const infoHash = '4dcf5a252e2dfcc3c72c29c82edfc08d48915038';
const ticket = generateStreamTicket({ infoHash, req: { headers: { 'user-agent': 'TestRunner' }, ip: '127.0.0.1' } });

console.log('Generated ticket:', ticket);

// Test seeking with &t=900 (15 minutes in)
const transcodeUrl = `http://localhost:3000/stream/play/${ticket}?transcode=audio&t=900`;
console.log('Testing seek endpoint:', transcodeUrl);

const startTime = Date.now();
const req = http.get(transcodeUrl, {
  headers: {
    'User-Agent': 'TestRunner',
    'Referer': 'http://localhost:3000/movie/550'
  }
}, (res) => {
  console.log(`Transcode response status: ${res.statusCode}`);
  console.log('Headers:', {
    contentType: res.headers['content-type'],
    streamStartTime: res.headers['x-stream-start-time'],
    acceptRanges: res.headers['accept-ranges']
  });

  let received = 0;
  res.on('data', (chunk) => {
    received += chunk.length;
    if (received > 32768) {
      console.log(`SUCCESS! Stream yielded ${received} bytes starting from 900s in ${Date.now() - startTime}ms`);
      req.destroy();
      process.exit(0);
    }
  });
  res.on('error', (err) => {
    if (req.destroyed) process.exit(0);
    console.error('Response error:', err.message);
  });
});

req.on('error', (err) => {
  if (req.destroyed) process.exit(0);
  console.error('Request error:', err.message);
});

setTimeout(() => {
  console.log('Timed out waiting for data');
  req.destroy();
  process.exit(1);
}, 30000);
