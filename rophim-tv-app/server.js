'use strict';

var http = require('http');
var https = require('https');
var dns = require('dns');
var urlModule = require('url');
var fs = require('fs');
var path = require('path');
var os = require('os');
var adblockerFactory = require('./adblocker');

if (dns.setDefaultResultOrder) {
  try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
}

var PORT = Number(process.env.PORT || 5020);
var ROPHIM_ORIGIN = 'https://www.rophim.net';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var LOG_FILE = process.platform === 'win32'
  ? path.resolve(__dirname, '..', 'rophim-simulator.log')
  : '/tmp/rophim-proxy.log';

var adblocker = adblockerFactory.createAdBlocker();

var MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.vtt': 'text/vtt; charset=utf-8'
};

function writeLog(tag, msg) {
  var line = '[' + new Date().toISOString() + '] [' + tag + '] ' + msg + '\n';
  try { process.stdout.write(line); } catch (e) {}
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (e) {}
}

function getLocalIP() {
  var interfaces = os.networkInterfaces();
  var names = Object.keys(interfaces);
  for (var i = 0; i < names.length; i++) {
    var list = interfaces[names[i]];
    for (var j = 0; j < list.length; j++) {
      if (list[j].family === 'IPv4' && !list[j].internal) {
        return list[j].address;
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

function sendJson(res, status, obj) {
  setCorsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function requestUpstream(targetUrlStr, method, headers, bodyBuf, redirectsLeft, callback) {
  if (redirectsLeft <= 0) return callback(new Error('Too many redirects'));
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
    headers: headers || {},
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
    upstreamRes.on('data', function (chunk) { chunks.push(chunk); });
    upstreamRes.on('end', function () {
      callback(null, status, upstreamRes.headers, Buffer.concat(chunks), targetUrlStr);
    });
  });

  upstreamReq.setTimeout(15000, function () {
    upstreamReq.abort();
    callback(new Error('Upstream timeout: ' + targetUrlStr.slice(0, 60)));
  });

  upstreamReq.on('error', function (err) {
    callback(err);
  });

  if (bodyBuf && bodyBuf.length > 0) upstreamReq.write(bodyBuf);
  upstreamReq.end();
  return upstreamReq;
}

function fetchJsonPromise(urlStr, extraHeaders) {
  return new Promise(function (resolve, reject) {
    var hdrs = Object.assign({
      'User-Agent': UA,
      'Referer': ROPHIM_ORIGIN + '/',
      'Accept': 'application/json, text/plain, */*'
    }, extraHeaders || {});
    requestUpstream(urlStr, 'GET', hdrs, null, 5, function (err, status, h, buf) {
      if (err) return reject(err);
      try {
        resolve({ status: status, data: JSON.parse(buf.toString('utf8')) });
      } catch (e) {
        reject(new Error('Invalid JSON from ' + urlStr + ' (HTTP ' + status + ')'));
      }
    });
  });
}

function fetchTextPromise(urlStr, extraHeaders) {
  return new Promise(function (resolve, reject) {
    var hdrs = Object.assign({
      'User-Agent': UA,
      'Referer': ROPHIM_ORIGIN + '/',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }, extraHeaders || {});
    requestUpstream(urlStr, 'GET', hdrs, null, 5, function (err, status, h, buf, finalUrl) {
      if (err) return reject(err);
      resolve({ status: status, headers: h, text: buf.toString('utf8'), finalUrl: finalUrl });
    });
  });
}

function stripHtmlTags(str) {
  if (!str) return '';
  return String(str).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeMovie(m) {
  if (!m) return null;
  var poster = m.thumbnail || m.poster || m.thumbnailFallback || m.posterFallback || '';
  var backdrop = m.poster || m.thumbnail || m.posterFallback || m.thumbnailFallback || '';
  return {
    id: m.id,
    slug: m.slug,
    name: m.name || m.title || 'Không rõ tên',
    origin_name: m.origin_name || m.originName || '',
    description: stripHtmlTags(m.description || ''),
    poster: poster,
    backdrop: backdrop,
    quality: m.quality || 'HD',
    publish_year: m.publish_year || m.publishYear || '',
    episode_current: m.episode_current || m.episodeCurrent || '',
    episode_total: m.episode_total || m.episodeTotal || '',
    language: m.language || 'Vietsub',
    type: m.type || ''
  };
}

function extractBalancedJson(str, startIdx, openChar, closeChar) {
  var depth = 0;
  var inStr = false;
  var escaped = false;
  for (var i = startIdx; i < str.length; i++) {
    var ch = str[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === openChar) depth++;
      else if (ch === closeChar) {
        depth--;
        if (depth === 0) return str.slice(startIdx, i + 1);
      }
    }
  }
  return null;
}

function extractEpisodesFromWatchHtml(html) {
  var chunks = [];
  var re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    try {
      chunks.push(JSON.parse('"' + m[1] + '"'));
    } catch (e) {}
  }
  var fullRsc = chunks.join('');

  // Parse active "episode":{...} first (needed to resolve Next.js RSC pointers like "$56:...:episode" in Phim Le)
  var activeEpisode = null;
  var epKey = fullRsc.indexOf('"episode":{');
  if (epKey !== -1) {
    var objStart = fullRsc.indexOf('{', epKey);
    var objStr = extractBalancedJson(fullRsc, objStart, '{', '}');
    if (objStr) {
      try {
        var parsedSingle = JSON.parse(objStr);
        if (parsedSingle && typeof parsedSingle === 'object' && typeof parsedSingle.link === 'string' && parsedSingle.link.indexOf('http') === 0) {
          activeEpisode = parsedSingle;
        }
      } catch (e) {}
    }
  }

  var rawEpisodes = [];
  var epsKey = fullRsc.indexOf('"episodes":[');
  if (epsKey !== -1) {
    var arrStart = fullRsc.indexOf('[', epsKey);
    var jsonStr = extractBalancedJson(fullRsc, arrStart, '[', ']');
    if (jsonStr) {
      try {
        rawEpisodes = JSON.parse(jsonStr);
      } catch (e) {}
    }
  }

  // Resolve RSC pointer strings (e.g. "$56:props:children:1:props:episode") and filter only valid episode objects
  var episodes = [];
  var seenEpIds = {};
  for (var ri = 0; ri < rawEpisodes.length; ri++) {
    var item = rawEpisodes[ri];
    if (typeof item === 'string' && item.indexOf('episode') !== -1 && activeEpisode) {
      item = activeEpisode;
    }
    if (item && typeof item === 'object' && typeof item.link === 'string' && item.link.indexOf('http') === 0) {
      var epKeyId = String(item.id || item.link);
      if (!seenEpIds[epKeyId]) {
        seenEpIds[epKeyId] = true;
        episodes.push(item);
      }
    }
  }

  if (activeEpisode) {
    var actId = String(activeEpisode.id || activeEpisode.link);
    if (!seenEpIds[actId]) {
      episodes.unshift(activeEpisode);
    }
  }

  // Group by server name (Vietsub, Thuyết Minh, Lồng Tiếng...)
  var serverMap = {};
  var serverOrder = [];
  for (var i = 0; i < episodes.length; i++) {
    var ep = episodes[i];
    if (!ep || !ep.link) continue;
    var srvName = (ep.server && String(ep.server).trim()) || 'Vietsub';
    if (!serverMap[srvName]) {
      serverMap[srvName] = [];
      serverOrder.push(srvName);
    }
    serverMap[srvName].push({
      id: ep.id,
      name: ep.name || ('Tập ' + (ep.order_index || (serverMap[srvName].length + 1))),
      slug: ep.slug || '',
      order_index: ep.order_index || (serverMap[srvName].length + 1),
      server: srvName,
      link: String(ep.link).replace(/&amp;/g, '&').replace(/\\u0026/g, '&')
    });
  }

  var groups = serverOrder.map(function (srv) {
    var eps = serverMap[srv];
    eps.sort(function (a, b) { return (a.order_index || 0) - (b.order_index || 0); });
    return { name: srv, episodes: eps };
  });

  // Also check if page had any ad banner links and record them as blocked by our clean API parser
  var adBannerMatches = html.match(/cdn\.rophim\.co\.com\/storage\/ads\/[^\s"'<>]+/g) || [];
  if (adBannerMatches.length > 0 && adblocker.getConfig().enabled && adblocker.getConfig().blockDomains) {
    adblocker.recordBlock('DOMAIN', 'cdn.rophim.co.com/storage/ads/*', 'Chặn ' + adBannerMatches.length + ' banner QC trang web');
  }

  return groups;
}

// ===== ROUTE HANDLERS =====
async function handleHome(req, res) {
  try {
    var results = await Promise.all([
      fetchJsonPromise(ROPHIM_ORIGIN + '/api/site/blocks/top-rated').catch(function () { return { data: [] }; }),
      fetchJsonPromise(ROPHIM_ORIGIN + '/api/site/blocks/home?page=1').catch(function () { return { data: {} }; }),
      fetchJsonPromise(ROPHIM_ORIGIN + '/api/site/blocks/home?page=2').catch(function () { return { data: {} }; }),
      fetchJsonPromise(ROPHIM_ORIGIN + '/api/site/blocks/home?page=3').catch(function () { return { data: {} }; })
    ]);

    // Record blocking of RoPhim's homepage banner ads endpoint (which our app intentionally skips!)
    if (adblocker.getConfig().enabled && adblocker.getConfig().blockDomains) {
      adblocker.recordBlock('DOMAIN', '/api/v1/banners/public', 'Bỏ qua API banner quảng cáo trang chủ RoPhim');
    }

    var topRaw = Array.isArray(results[0].data) ? results[0].data : [];
    var hero = topRaw.map(normalizeMovie).filter(Boolean);

    var collections = [];
    for (var p = 1; p <= 3; p++) {
      var d = results[p].data;
      var cols = (d && d.result && Array.isArray(d.result.collections)) ? d.result.collections : [];
      for (var c = 0; c < cols.length; c++) {
        var col = cols[c];
        var movies = Array.isArray(col.movies) ? col.movies.map(normalizeMovie).filter(Boolean) : [];
        if (movies.length > 0) {
          collections.push({
            id: col.id,
            title: col.name || col.title || 'Tuyển tập',
            movies: movies
          });
        }
      }
    }

    if (!hero.length && collections.length) {
      hero = collections[0].movies.slice(0, 8);
    }

    writeLog('API', 'GET /api/home -> hero:' + hero.length + ', collections:' + collections.length);
    sendJson(res, 200, { hero: hero, collections: collections });
  } catch (err) {
    writeLog('API-ERR', 'GET /api/home -> ' + err.message);
    sendJson(res, 502, { error: err.message });
  }
}

async function handleSearch(req, res, keyword) {
  if (!keyword) return sendJson(res, 200, { movies: [] });
  try {
    var result = await fetchJsonPromise(ROPHIM_ORIGIN + '/api/site/search?q=' + encodeURIComponent(keyword));
    var list = (result.data && Array.isArray(result.data.movies)) ? result.data.movies.map(normalizeMovie).filter(Boolean) : [];
    writeLog('API', 'GET /api/search?q=' + keyword + ' -> ' + list.length + ' results');
    sendJson(res, 200, { movies: list });
  } catch (err) {
    writeLog('API-ERR', 'GET /api/search -> ' + err.message);
    sendJson(res, 502, { error: err.message, movies: [] });
  }
}

async function handleMovie(req, res, slug) {
  if (!slug) return sendJson(res, 400, { error: 'Missing slug' });
  try {
    var page = await fetchTextPromise(ROPHIM_ORIGIN + '/xem-phim/' + encodeURIComponent(slug));
    var groups = extractEpisodesFromWatchHtml(page.text);
    writeLog('API', 'GET /api/movie?slug=' + slug + ' -> ' + groups.length + ' servers');
    sendJson(res, 200, { slug: slug, groups: groups });
  } catch (err) {
    writeLog('API-ERR', 'GET /api/movie?slug=' + slug + ' -> ' + err.message);
    sendJson(res, 502, { error: err.message, groups: [] });
  }
}

async function handleResolveStream(req, res, embedUrl) {
  if (!embedUrl) return sendJson(res, 400, { error: 'Missing embed url' });
  try {
    var embedPage = await fetchTextPromise(embedUrl, { 'Referer': ROPHIM_ORIGIN + '/' });
    var dataMatch = embedPage.text.match(/window\.__EMBED_DATA__\s*=\s*(\{[\s\S]*?\});/);
    if (!dataMatch) {
      writeLog('RESOLVE-ERR', 'No __EMBED_DATA__ found in ' + embedUrl);
      return sendJson(res, 200, { mode: 'iframe', url: embedUrl, sources: [] });
    }

    var rawEmbed = JSON.parse(dataMatch[1]);
    // Run Ad-Blocker Layer 1: strip embed ads (streamxx.net, tvc_mp4, popups, banners, trackers)
    var cleanEmbed = adblocker.sanitizeEmbedData(rawEmbed);

    var embedParsed = urlModule.parse(embedUrl);
    var embedOrigin = embedParsed.protocol + '//' + embedParsed.host;
    var baseStream = embedOrigin + '/embed/' + cleanEmbed.siteId + '/' + cleanEmbed.videoSourceId;
    var token = cleanEmbed.embedToken || '';
    var avail = cleanEmbed.availability || {};

    var hostPrefix = 'http://' + (req.headers.host || ('127.0.0.1:' + PORT));
    var sources = [];

    // Prefer tier=clean (ad-free direct HLS), then tier=m3u8
    if (avail.has_clean) {
      var cleanUrl = baseStream + '/stream?tier=clean&embed_token=' + encodeURIComponent(token);
      sources.push({
        label: 'VIP Clean (Không QC)',
        tier: 'clean',
        type: 'hls',
        streamUrl: hostPrefix + '/proxy/stream?url=' + encodeURIComponent(cleanUrl) + '&ref=' + encodeURIComponent(embedUrl) + '&tk=' + encodeURIComponent(token)
      });
    }
    if (avail.has_m3u8) {
      var m3u8Url = baseStream + '/stream?tier=m3u8&embed_token=' + encodeURIComponent(token);
      sources.push({
        label: 'HLS Dự phòng',
        tier: 'm3u8',
        type: 'hls',
        streamUrl: hostPrefix + '/proxy/stream?url=' + encodeURIComponent(m3u8Url) + '&ref=' + encodeURIComponent(embedUrl) + '&tk=' + encodeURIComponent(token)
      });
    }

    writeLog('RESOLVE', 'Resolved ' + cleanEmbed.videoSourceId + ' -> ' + sources.length + ' clean HLS sources (adblock=' + adblocker.getConfig().enabled + ')');
    sendJson(res, 200, {
      mode: sources.length > 0 ? 'hls' : 'iframe',
      embedUrl: embedUrl,
      sources: sources,
      adblockStats: adblocker.getStats()
    });
  } catch (err) {
    writeLog('RESOLVE-ERR', err.message);
    sendJson(res, 502, { error: err.message });
  }
}

function handleStreamProxy(req, res, query) {
  var targetUrlStr = query && query.url;
  var refStr = (query && query.ref) || (ROPHIM_ORIGIN + '/');
  var tkStr = (query && query.tk) || '';

  if (!targetUrlStr) {
    res.writeHead(400);
    return res.end('Missing url');
  }

  // Ad-Blocker Layer 1: Check if target URL is an ad/tracker domain or path
  var adReason = adblocker.isAdUrl(targetUrlStr);
  if (adReason) {
    adblocker.recordBlock('DOMAIN', targetUrlStr, adReason);
    writeLog('ADBLOCK', 'Blocked stream URL: ' + targetUrlStr.slice(0, 70) + ' (' + adReason + ')');
    setCorsHeaders(res);
    res.writeHead(204);
    return res.end();
  }

  var headers = {
    'User-Agent': UA,
    'Referer': refStr,
    'Accept': '*/*'
  };
  if (tkStr) {
    headers['Authorization'] = 'Bearer ' + tkStr;
  }

  var upReq = requestUpstream(targetUrlStr, 'GET', headers, null, 5, function (err, status, upHeaders, buf, finalUrl) {
    // Auto-fallback from tier=clean -> tier=m3u8 if upstream returns 401/403/404 (e.g. bad_auth_token on B2 clean storage)
    if (!err && status >= 400 && targetUrlStr.indexOf('tier=clean') !== -1) {
      var fallbackUrl = targetUrlStr.replace('tier=clean', 'tier=m3u8');
      writeLog('FALLBACK', 'tier=clean returned HTTP ' + status + ' -> auto-switching to tier=m3u8 + HLS AdBlocker');
      return handleStreamProxy(req, res, { url: fallbackUrl, ref: refStr, tk: tkStr });
    }

    setCorsHeaders(res);
    if (err) {
      writeLog('STREAM-ERR', targetUrlStr.slice(0, 65) + ' -> ' + err.message);
      res.writeHead(502);
      return res.end('Stream proxy error: ' + err.message);
    }

    var contentType = ((upHeaders && upHeaders['content-type']) || 'application/octet-stream').toLowerCase();
    var headStr = buf.slice(0, 32).toString('utf8').replace(/^\s+/, '');

    if (headStr.indexOf('#EXTM3U') === 0 || targetUrlStr.indexOf('.m3u8') !== -1 || contentType.indexOf('mpegurl') !== -1) {
      var rawText = buf.toString('utf8');
      // Ad-Blocker Layer 2: Filter out HLS discontinuity / SCTE-35 / foreign-domain ad segments
      var filtered = adblocker.filterM3u8Playlist(rawText, finalUrl || targetUrlStr);
      var hostPrefix = 'http://' + (req.headers.host || ('127.0.0.1:' + PORT));
      var baseForResolve = finalUrl || targetUrlStr;

      var rewritten = filtered.text.split('\n').map(function (line) {
        var trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.charAt(0) === '#') {
          return line.replace(/URI="([^"]+)"/g, function (_, uri) {
            var abs = urlModule.resolve(baseForResolve, uri);
            return 'URI="' + hostPrefix + '/proxy/stream?url=' + encodeURIComponent(abs) + '&ref=' + encodeURIComponent(refStr) + '"';
          });
        }
        var absSeg = urlModule.resolve(baseForResolve, trimmed);
        return hostPrefix + '/proxy/stream?url=' + encodeURIComponent(absSeg) + '&ref=' + encodeURIComponent(refStr);
      }).join('\n');

      writeLog('M3U8', targetUrlStr.slice(0, 65) + ' -> ' + status + ' (ads removed: ' + filtered.removedCount + ')');
      res.writeHead(status, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache'
      });
      return res.end(rewritten);
    }

    // Serve clean video/ts/key/subtitle segment
    var outCt = contentType;
    if (targetUrlStr.indexOf('.ts') !== -1 && outCt.indexOf('octet-stream') !== -1) {
      outCt = 'video/mp2t';
    }
    res.writeHead(status, {
      'Content-Type': outCt,
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=3600'
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

  if (pathname === '/api/log' && req.method === 'POST') {
    var logChunks = [];
    req.on('data', function (c) { logChunks.push(c); });
    req.on('end', function () {
      writeLog('CLIENT', Buffer.concat(logChunks).toString('utf8'));
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/home') return handleHome(req, res);
  if (pathname === '/api/search') return handleSearch(req, res, (parsed.query && parsed.query.q) || '');
  if (pathname === '/api/movie') return handleMovie(req, res, (parsed.query && parsed.query.slug) || '');
  if (pathname === '/api/resolve') return handleResolveStream(req, res, (parsed.query && parsed.query.embed) || '');
  if (pathname === '/proxy/stream') return handleStreamProxy(req, res, parsed.query);

  if (pathname === '/api/adblock/stats') {
    return sendJson(res, 200, adblocker.getStats());
  }
  if (pathname === '/api/adblock/config' && req.method === 'POST') {
    var cfgChunks = [];
    req.on('data', function (c) { cfgChunks.push(c); });
    req.on('end', function () {
      try {
        var patch = JSON.parse(Buffer.concat(cfgChunks).toString('utf8'));
        adblocker.updateConfig(patch);
      } catch (e) {}
      sendJson(res, 200, adblocker.getStats());
    });
    return;
  }
  if (pathname === '/api/adblock/reset' && req.method === 'POST') {
    adblocker.resetStats();
    return sendJson(res, 200, adblocker.getStats());
  }

  // Static files for testing in browser
  var relFile = pathname === '/' ? '/index.html' : pathname;
  relFile = path.normalize(relFile).replace(/^(\.\.[/\\])+/, '');
  var fullPath = path.join(__dirname, relFile);
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    var ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(fullPath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('404 Not Found');
  }
});

server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    writeLog('BOOT', 'Port ' + PORT + ' already listening — reusing existing RoPhim Proxy Server.');
  } else {
    writeLog('BOOT-ERR', err ? err.message : String(err));
  }
});

server.listen(PORT, '0.0.0.0', function () {
  writeLog('BOOT', 'RoPhim TV Server + AdBlocker listening on http://127.0.0.1:' + PORT + ' and http://' + getLocalIP() + ':' + PORT);
});
