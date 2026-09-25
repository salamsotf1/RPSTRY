const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const port = Number(process.env.PORT || 8000);
const root = __dirname;
const clients = new Set();
let activeRun = null;

function sendEvent(event) {
  const payload = `event: test\ndata: ${JSON.stringify(event)}\n\n`;
  clients.forEach((client) => client.write(payload));
}

function classifyTest(title) {
  if (/Master AWB|AWB number search/i.test(title)) return 'Global AWB / Master AWB';
  if (/saved bookings|deleting saved bookings/i.test(title)) return 'Billing / Saved Bookings';
  return 'New Booking';
}

function startTestRun(response) {
  if (activeRun) {
    response.writeHead(409, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'A test run is already in progress.' }));
    return;
  }

  response.writeHead(202, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ started: true }));

  const runId = Date.now();
  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'test', '--reporter=./dashboard-reporter.js'], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  activeRun = { child, runId };
  sendEvent({ type: 'run-start', runId });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    const lines = output.split('\n');
    output = lines.pop();
    lines.forEach((line) => {
      if (!line.startsWith('AIR_CARGO_TEST_EVENT ')) return;
      try {
        sendEvent(JSON.parse(line.slice('AIR_CARGO_TEST_EVENT '.length)));
      } catch (error) {
        sendEvent({ type: 'log', message: line });
      }
    });
  });
  child.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) sendEvent({ type: 'log', message });
  });
  child.on('close', (code) => {
    sendEvent({ type: 'run-end', runId, exitCode: code, status: code === 0 ? 'passed' : 'failed' });
    activeRun = null;
  });
  child.on('error', (error) => {
    sendEvent({ type: 'run-end', runId, exitCode: 1, status: 'failed', error: error.message });
    activeRun = null;
  });
}

function serveFile(request, response) {
  const requestPath = request.url === '/' ? '/index.html' : request.url.split('?')[0];
  const filePath = path.resolve(root, `.${requestPath}`);
  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  const extension = path.extname(filePath);
  const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  response.writeHead(200, { 'Content-Type': contentTypes[extension] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/api/test-events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    response.write(': connected\n\n');
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (request.method === 'POST' && request.url === '/api/run-tests') {
    startTestRun(response);
    return;
  }
  if (request.method === 'GET') {
    serveFile(request, response);
    return;
  }
  response.writeHead(405);
  response.end('Method not allowed');
});

server.listen(port, () => console.log(`AirCargo running at http://localhost:${port}`));
