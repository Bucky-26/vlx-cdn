const http = require('http');
const { generateStreamTicket } = require('../src/services/streamSecurity');

const infoHash = '4dcf5a252e2dfcc3c72c29c82edfc08d48915038';
const ticket = generateStreamTicket({ infoHash, req: { headers: { 'user-agent': 'Mozilla/5.0' }, ip: '127.0.0.1' } });

console.log('Ticket:', ticket);

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: `/stream/play/${ticket}?transcode=audio&t=60`,
  method: 'GET',
  headers: {
    'User-Agent': 'Mozilla/5.0',
    'Sec-Fetch-Dest': 'video',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'same-origin',
    'Referer': 'http://localhost:3000/movie/550'
  }
}, (res) => {
  console.log('Response Status:', res.statusCode);
  console.log('Response Headers:', res.headers);
  res.on('data', chunk => {
    console.log('Received chunk of length:', chunk.length);
    req.destroy();
    process.exit(0);
  });
});

req.on('error', (e) => {
  console.error('Request error:', e.message);
});

req.end();

setTimeout(() => {
  console.log('Timeout');
  process.exit(1);
}, 10000);
