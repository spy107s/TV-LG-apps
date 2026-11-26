const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 5010;
const API_BASE = 'https://animevui.com/api';
const LOG_FILE = path.resolve(__dirname, '..', 'simulator-debug.log');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.vtt': 'text/vtt; charset=utf-8'
};

function writeLog(tag, msg) {
  const line = `[${new Date().toISOString()}] [${tag}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (e) {}
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

function stripFakeHeaderIfMpegTs(buf) {
  if (!buf || buf.length < 564) return null;
  if (buf[0] === 0x47 && buf[188] === 0x47 && buf[376] === 0x47) {
    return buf; // Already clean MPEG-TS
  }
  const limit = Math.min(buf.length - 376, 32768);
  for (let i = 1; i < limit; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) {
      return buf.slice(i);
    }
  }
  return null;
}

async function handleApiProxy(req, res, apiPath) {
  const targetUrl = API_BASE + apiPath;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://anime47.best/',
    'Origin': 'https://anime47.best',
    'Accept': 'application/json, text/plain, */*'
  };

  if (req.headers['authorization']) {
    headers['Authorization'] = req.headers['authorization'];
  }
  if (req.headers['content-type']) {
    headers['Content-Type'] = req.headers['content-type'];
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body
    });

    setCorsHeaders(res);
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    const buf = Buffer.from(await upstream.arrayBuffer());
    writeLog('API', `${req.method} ${apiPath} -> ${upstream.status} (${buf.length} bytes)`);
    res.writeHead(upstream.status, { 'Content-Type': contentType });
    res.end(buf);
  } catch (err) {
    writeLog('API-ERR', `${req.method} ${apiPath} -> ${err.message}`);
    setCorsHeaders(res);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: false, message: 'Proxy error: ' + err.message }));
  }
}

async function handleStreamProxy(req, res, targetUrlStr) {
  if (!targetUrlStr) {
    res.writeHead(400);
    return res.end('Missing url parameter');
  }

  const abortCtrl = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      abortCtrl.abort();
    }
  });

  try {
    const targetUrl = new URL(targetUrlStr);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://anime47.best/',
      'Origin': 'https://anime47.best'
    };

    const upstream = await fetch(targetUrl.toString(), { headers, signal: abortCtrl.signal });
    const contentType = (upstream.headers.get('content-type') || 'application/octet-stream').toLowerCase();
    const buf = Buffer.from(await upstream.arrayBuffer());
    setCorsHeaders(res);

    // Check if response is an HLS playlist (.m3u8 or starts with #EXTM3U)
    const headStr = buf.slice(0, 32).toString('utf8').trimStart();
    if (headStr.startsWith('#EXTM3U') || targetUrl.pathname.includes('.m3u8') || contentType.includes('mpegurl')) {
      const text = buf.toString('utf8');
      const hostPrefix = `http://${req.headers.host || ('localhost:' + PORT)}`;
      const rewritten = text.split('\n').map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) => {
            const abs = new URL(uri, targetUrl).toString();
            return `URI="${hostPrefix}/proxy/stream?url=${encodeURIComponent(abs)}"`;
          });
        }
        const abs = new URL(trimmed, targetUrl).toString();
        return `${hostPrefix}/proxy/stream?url=${encodeURIComponent(abs)}`;
      }).join('\n');

      writeLog('M3U8', `${targetUrl.hostname}${targetUrl.pathname.slice(0, 40)} -> ${upstream.status} (${buf.length} bytes)`);
      res.writeHead(upstream.status, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache'
      });
      return res.end(rewritten);
    }

    // Check if response is a disguised MPEG-TS segment (e.g. PNG header prepended to 0x47 TS packets)
    const cleanTs = stripFakeHeaderIfMpegTs(buf);
    if (cleanTs) {
      const strippedBytes = buf.length - cleanTs.length;
      writeLog('TS-SEG', `${targetUrl.hostname} -> ${upstream.status} (stripped ${strippedBytes}B fake PNG header, TS=${cleanTs.length}B)`);
      res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Content-Length': cleanTs.length,
        'Cache-Control': 'public, max-age=3600'
      });
      return res.end(cleanTs);
    }

    writeLog('STREAM', `${targetUrl.hostname}${targetUrl.pathname.slice(0, 40)} -> ${upstream.status} (${contentType}, ${buf.length}B)`);
    res.writeHead(upstream.status, {
      'Content-Type': contentType,
      'Content-Length': buf.length
    });
    res.end(buf);
  } catch (err) {
    writeLog('STREAM-ERR', `${targetUrlStr.slice(0, 80)} -> ${err.message}`);
    setCorsHeaders(res);
    res.writeHead(502);
    res.end('Stream proxy error: ' + err.message);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (parsedUrl.pathname === '/proxy/log' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyStr = Buffer.concat(chunks).toString('utf8');
    writeLog('CLIENT', bodyStr);
    setCorsHeaders(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  if (parsedUrl.pathname.startsWith('/proxy/api')) {
    const apiPath = parsedUrl.pathname.slice('/proxy/api'.length) + parsedUrl.search;
    return handleApiProxy(req, res, apiPath);
  }

  if (parsedUrl.pathname === '/proxy/stream') {
    const target = parsedUrl.searchParams.get('url');
    return handleStreamProxy(req, res, target);
  }

  // Static file serving
  let filePath = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(__dirname, filePath);

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(fullPath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    writeLog('BOOT', `Port ${PORT} is already in use — reusing existing Proxy Server.`);
  } else {
    writeLog('BOOT-ERR', err ? err.message : String(err));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  writeLog('BOOT', `Anime47 TV App Server listening on http://localhost:${PORT} and http://${ip}:${PORT}`);
});
