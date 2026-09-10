const http = require('http');

async function main() {
  console.log('1. Fetching SSE stream for movie 550...');
  
  const streamInfo = await new Promise((resolve, reject) => {
    const req = http.get('http://localhost:3000/api/movie/550', {
      headers: { 'Accept': 'text/event-stream' }
    }, (res) => {
      let buffer = '';
      let readyData = null;
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
          else if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (currentEvent === 'stream' || currentEvent === 'ready') {
              try {
                readyData = JSON.parse(dataStr);
                req.destroy();
                resolve(readyData);
                return;
              } catch (e) {}
            }
          }
        }
      });
      res.on('end', () => {
        if (readyData) resolve(readyData);
        else reject(new Error('SSE closed without ready stream'));
      });
    });
    req.on('error', reject);
    setTimeout(() => {
      req.destroy();
      reject(new Error('Timeout waiting for SSE'));
    }, 15000);
  });

  console.log('Stream ready data:', {
    infoHash: streamInfo.infoHash,
    filename: streamInfo.filename,
    streamUrl: streamInfo.streamUrl,
    needsTranscode: streamInfo.needsTranscode
  });

  // Now test seeking in transcode stream with &t=600 (10 minutes)
  const ticket = streamInfo.ticket;
  const transcodeUrl = `http://localhost:3000/stream/play/${ticket}?transcode=audio&t=600`;
  console.log(`2. Requesting transcode stream seek: ${transcodeUrl}`);

  const startTime = Date.now();
  await new Promise((resolve, reject) => {
    const req = http.get(transcodeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        'Referer': 'http://localhost:3000/movie/550'
      }
    }, (res) => {
      console.log(`Transcode response status: ${res.statusCode}`);
      console.log('Headers:', {
        contentType: res.headers['content-type'],
        streamStartTime: res.headers['x-stream-start-time'],
        acceptRanges: res.headers['accept-ranges']
      });

      let receivedBytes = 0;
      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > 65536) { // received > 64KB of transcoded MP4
          console.log(`Successfully received ${receivedBytes} bytes in ${Date.now() - startTime}ms!`);
          req.destroy();
          resolve();
        }
      });
      res.on('error', (err) => {
        if (req.destroyed) resolve();
        else reject(err);
      });
    });
    req.on('error', (err) => {
      if (req.destroyed) resolve();
      else reject(err);
    });
    setTimeout(() => {
      req.destroy();
      reject(new Error('Timeout waiting for transcode response'));
    }, 20000);
  });

  console.log('Transcode seeking test PASSED flawlessly!');
}

main().catch(err => {
  console.error('Test error:', err.message);
  process.exit(1);
});
