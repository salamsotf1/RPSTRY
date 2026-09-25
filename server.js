const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const port = Number(process.env.PORT || 8000);
const root = __dirname;
const clients = new Set();
let activeRun = null;

function readAirCargoContext() {
  const files = ['index.html', 'app.js', 'styles.css'];
  return files.map((fileName) => {
    const filePath = path.join(root, fileName);
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath, 'utf8');
    return `FILE: ${fileName}\n${content.slice(0, 12000)}`;
  }).join('\n\n');
}

function extractTextFromHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchAirCargoWebContext() {
  const candidateUrls = [
    `http://localhost:${port}/index.html`,
    `http://localhost:${port}/`,
    `http://localhost:${port}/app.js`,
    `http://localhost:${port}/styles.css`
  ];

  const chunks = [];
  for (const url of candidateUrls) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!response.ok) continue;
      const text = await response.text();
      const cleaned = extractTextFromHtml(text);
      if (cleaned) chunks.push(`URL: ${url}\n${cleaned.slice(0, 15000)}`);
    } catch (error) {
      // Ignore fetch errors and use local source as fallback context.
    }
  }

  if (chunks.length) return chunks.join('\n\n');
  return readAirCargoContext();
}

async function callLlm(question, pageContext) {
  const azureKey = process.env.AZURE_OPENAI_API_KEY;
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const azureApiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';

  if (azureKey && azureEndpoint && azureDeployment) {
    const url = `${azureEndpoint.replace(/\/$/, '')}/openai/deployments/${azureDeployment}/chat/completions?api-version=${azureApiVersion}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': azureKey
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: 'Answer shipment-booking questions strictly from the supplied AirCargo page content. If a fact is missing, say so clearly.'
          },
          {
            role: 'user',
            content: `Question: ${question}\n\nPage content:\n${pageContext.slice(0, 30000)}`
          }
        ],
        temperature: 0.2,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure OpenAI request failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'Answer shipment-booking questions strictly from the supplied AirCargo page content. If a fact is missing, say so clearly.'
        },
        {
          role: 'user',
          content: `Question: ${question}\n\nPage content:\n${pageContext.slice(0, 30000)}`
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || null;
}

function generateFallbackAnswer(question) {
  const lower = (question || '').toLowerCase();
  if (/awb|master awb|air waybill/.test(lower)) {
    return 'In the Lift Aircargo flow, the AWB number is captured in the AWB field and stored for later retrieval. The system supports booking search by AWB and master AWB lookup, which lets the operator reopen or review the route, cargo, and shipment details from saved records.';
  }

  if (/(origin|destination|route|from|to)/.test(lower)) {
    return 'The booking form captures route information through origin and destination fields, then summarizes the path as “Origin → Destination”. This is also reflected in the shipment estimate panel and route preview shown during booking creation.';
  }

  if (/(pieces|weight|volume|cargo|description)/.test(lower)) {
    return 'Cargo details include pieces, total weight, volume, and a cargo description. These values are validated before booking creation, then saved alongside the booking and used in later search and billing views.';
  }

  if (/(saved booking|search booking|billing|history)/.test(lower)) {
    return 'Saved bookings are stored locally and can be searched, reviewed, and deleted from the billing view. The app also provides a paginated table of saved bookings so users can browse AWB records and shipment history.';
  }

  if (/(book|create booking|estimate|quote)/.test(lower)) {
    return 'To create a booking, the user fills in the route, cargo details, and AWB, then clicks “Create booking”. The app validates the shipment inputs, calculates an estimate, saves the booking, and shows a confirmation modal with the reference, route, cargo, and total.';
  }

  if (/(mcp|llm|read webpage|web page|screen)/.test(lower)) {
    return 'This MCP flow fetches the Lift Aircargo page content and grounds the answer in the actual booking screen context so the assistant can answer shipment-related questions from the application state instead of guessing.';
  }

  return 'The Lift Aircargo booking flow includes AWB capture, route setup, cargo details, estimate generation, and saved-booking search. The assistant supports questions about those parts of the workflow and can answer based on the current app page context.';
}

async function generateAssistantAnswer(question) {
  const pageContext = await fetchAirCargoWebContext();
  const llmAnswer = await callLlm(question, pageContext).catch(() => null);
  if (llmAnswer && llmAnswer.trim()) {
    return { answer: llmAnswer.trim(), source: 'OpenAI-compatible LLM via fetched web context', question };
  }

  return { answer: generateFallbackAnswer(question), source: 'Lift Aircargo page context (local fallback)', question };
}

async function handleMcpChat(request, response) {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) {
      request.destroy();
    }
  });

  request.on('end', async () => {
    try {
      const payload = body ? JSON.parse(body) : {};
      const question = String(payload.question || '').trim();
      const result = await generateAssistantAnswer(question || 'Can you explain the Lift Aircargo shipment booking flow?');
      response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      response.end(JSON.stringify({ answer: 'The MCP request was invalid. Please send a question in the JSON body.', error: error.message }));
    }
  });
}

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
  if (request.method === 'POST' && request.url === '/api/mcp/chat') {
    handleMcpChat(request, response);
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
