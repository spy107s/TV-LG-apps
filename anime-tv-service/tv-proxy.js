'use strict';

var http = require('http');
var https = require('https');
var dns = require('dns');
var urlModule = require('url');
var fs = require('fs');
var path = require('path');

if (dns.setDefaultResultOrder) {
  try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
}

var PORT = 5010;
var LOG_PATH = process.platform === 'win32'
  ? path.resolve(__dirname, '..', 'simulator-debug.log')
  : '/tmp/a47proxy.log';

function writeLog(tag, msg) {
  var line = '[' + new Date().toISOString() + '] [' + tag + '] ' + msg + '\n';
  try {
    process.stdout.write(line);
  } catch (e) {}
  try {
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (e) {}
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

function sendJson(res, status, obj) {
  setCorsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function stripFakeHeaderIfMpegTs(buf) {
  if (!buf || buf.length < 564) return null;
  if (buf[0] === 0x47 && buf[188] === 0x47 && buf[376] === 0x47) {
    return buf;
  }
  var limit = Math.min(buf.length - 376, 32768);
  for (var i = 1; i < limit; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) {
      return buf.slice(i);
    }
  }
  return null;
}

function requestUpstream(targetUrlStr, method, headers, bodyBuf, redirectsLeft, callback) {
  if (redirectsLeft <= 0) {
    return callback(new Error('Too many redirects'));
  }
  var parsed;
  try {
    parsed = urlModule.parse(targetUrlStr);
  } catch (e) {
    return callback(e);
  }

  var isHttps = parsed.protocol === 'https:';
  var client = isHttps ? https : http;
  var reqOpts = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.path || '/',
    method: method || 'GET',
    headers: headers,
    family: 4,
    rejectUnauthorized: false
  };

  var upstreamReq = client.request(reqOpts, function (upstreamRes) {
    var status = upstreamRes.statusCode || 500;
    if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && upstreamRes.headers.location) {
      var nextUrl = urlModule.resolve(targetUrlStr, upstreamRes.headers.location);
      upstreamRes.resume();
      return requestUpstream(nextUrl, 'GET', headers, null, redirectsLeft - 1, callback);
    }

    var chunks = [];
    upstreamRes.on('data', function (chunk) {
      chunks.push(chunk);
    });
    upstreamRes.on('end', function () {
      var fullBuf = Buffer.concat(chunks);
      callback(null, status, upstreamRes.headers, fullBuf, targetUrlStr);
    });
  });

  upstreamReq.setTimeout(15000, function () {
    upstreamReq.abort();
    callback(new Error('Upstream timeout: ' + targetUrlStr.slice(0, 60)));
  });

  upstreamReq.on('error', function (err) {
    callback(err);
  });

  if (bodyBuf && bodyBuf.length > 0) {
    upstreamReq.write(bodyBuf);
  }
  upstreamReq.end();
  return upstreamReq;
}

function handleApiProxy(req, res, apiPath) {
  var targetUrl = 'https://animevui.com/api' + apiPath;
  var headers = {
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

  var bodyChunks = [];
  req.on('data', function (c) { bodyChunks.push(c); });
  req.on('end', function () {
    var bodyBuf = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : null;
    if (bodyBuf) headers['Content-Length'] = bodyBuf.length;

    requestUpstream(targetUrl, req.method, headers, bodyBuf, 5, function (err, status, upHeaders, buf) {
      setCorsHeaders(res);
      if (err) {
        writeLog('API-ERR', req.method + ' ' + apiPath + ' -> ' + err.message);
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ success: false, message: err.message }));
      }
      var ct = (upHeaders && upHeaders['content-type']) || 'application/json; charset=utf-8';
      writeLog('API', req.method + ' ' + apiPath + ' -> ' + status + ' (' + buf.length + 'B)');
      res.writeHead(status, { 'Content-Type': ct });
      res.end(buf);
    });
  });
}

function resolveRelativeUrl(baseStr, relStr) {
  try {
    return urlModule.resolve(baseStr, relStr);
  } catch (e) {
    return relStr;
  }
}

function handleStreamProxy(req, res, targetUrlStr) {
  if (!targetUrlStr) {
    res.writeHead(400);
    return res.end('Missing url');
  }

  var headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://anime47.best/',
    'Origin': 'https://anime47.best'
  };

  var upReq = requestUpstream(targetUrlStr, 'GET', headers, null, 5, function (err, status, upHeaders, buf, finalUrl) {
    setCorsHeaders(res);
    if (err) {
      writeLog('STREAM-ERR', targetUrlStr.slice(0, 60) + ' -> ' + err.message);
      res.writeHead(502);
      return res.end('Stream error: ' + err.message);
    }

    var contentType = ((upHeaders && upHeaders['content-type']) || 'application/octet-stream').toLowerCase();
    var headStr = buf.slice(0, 32).toString('utf8').replace(/^\s+/, '');

    if (headStr.indexOf('#EXTM3U') === 0 || targetUrlStr.indexOf('.m3u8') !== -1 || contentType.indexOf('mpegurl') !== -1) {
      var text = buf.toString('utf8');
      var baseForResolve = finalUrl || targetUrlStr;
      var hostPrefix = 'http://' + (req.headers.host || ('127.0.0.1:' + PORT));
      var rewritten = text.split('\n').map(function (line) {
        var trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.charAt(0) === '#') {
          return line.replace(/URI="([^"]+)"/g, function (_, uri) {
            var abs = resolveRelativeUrl(baseForResolve, uri);
            return 'URI="' + hostPrefix + '/proxy/stream?url=' + encodeURIComponent(abs) + '"';
          });
        }
        var absLine = resolveRelativeUrl(baseForResolve, trimmed);
        return hostPrefix + '/proxy/stream?url=' + encodeURIComponent(absLine);
      }).join('\n');

      writeLog('M3U8', targetUrlStr.slice(0, 65) + ' -> ' + status + ' (' + buf.length + 'B)');
      res.writeHead(status, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache'
      });
      return res.end(rewritten);
    }

    var cleanTs = stripFakeHeaderIfMpegTs(buf);
    if (cleanTs) {
      var stripped = buf.length - cleanTs.length;
      writeLog('TS-SEG', '200 (stripped ' + stripped + 'B fake PNG, TS=' + cleanTs.length + 'B)');
      res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Content-Length': cleanTs.length,
        'Cache-Control': 'public, max-age=3600'
      });
      return res.end(cleanTs);
    }

    writeLog('STREAM', targetUrlStr.slice(0, 65) + ' -> ' + status + ' (' + contentType + ', ' + buf.length + 'B)');
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': buf.length
    });
    res.end(buf);
  });

  req.on('close', function () {
    if (!res.finished && upReq && upReq.abort) {
      try { upReq.abort(); } catch (e) {}
    }
  });
}

var server = http.createServer(function (req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res);
    res.writeHead(204);
    return res.end();
  }

  var parsed = urlModule.parse(req.url, true);
  var pathname = parsed.pathname || '/';

  if (pathname === '/proxy/log' && req.method === 'POST') {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      writeLog('CLIENT', Buffer.concat(chunks).toString('utf8'));
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (pathname.indexOf('/proxy/api') === 0) {
    var apiPath = req.url.slice('/proxy/api'.length);
    return handleApiProxy(req, res, apiPath);
  }

  if (pathname === '/proxy/stream') {
    var target = parsed.query && parsed.query.url;
    return handleStreamProxy(req, res, target);
  }

  sendJson(res, 200, { status: 'Anime47 Local Proxy Running', port: PORT });
});

var isReady = false;
var readyCallbacks = [];

function markReady() {
  if (isReady) return;
  isReady = true;
  while (readyCallbacks.length > 0) {
    var cb = readyCallbacks.shift();
    try { cb(); } catch (e) {}
  }
}

function whenReady(cb) {
  if (typeof cb !== 'function') return;
  if (isReady) cb();
  else readyCallbacks.push(cb);
}

server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    writeLog('BOOT', 'Port ' + PORT + ' already listening — reusing existing Anime47 Proxy.');
    markReady();
  } else {
    writeLog('BOOT-ERR', err ? err.message : String(err));
    markReady();
  }
});

server.listen(PORT, '127.0.0.1', function () {
  writeLog('BOOT', 'Anime47 tv-proxy listening on http://127.0.0.1:' + PORT);
  markReady();
});

module.exports = {
  PORT: PORT,
  server: server,
  whenReady: whenReady
};
