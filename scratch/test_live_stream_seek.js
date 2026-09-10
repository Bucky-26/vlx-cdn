const http = require('http');

function testEndpoint(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3000${path}`, (res) => {
      console.log(`GET ${path} -> Status: ${res.statusCode}`);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 200) }));
    }).on('error', reject);
  });
}

async function run() {
  const home = await testEndpoint('/');
  console.log('Home status:', home.status);
}

run().catch(console.error);
