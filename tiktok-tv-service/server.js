'use strict';

var http = require('http');
var https = require('https');
var dns = require('dns');
var urlModule = require('url');
var zlib = require('zlib');
var fs = require('fs');
var path = require('path');

if (dns.setDefaultResultOrder) {
  try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
}

var PORT = Number(process.env.PORT || 5070);
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var LOG_FILE = process.platform === 'win32'
  ? path.resolve(__dirname, '..', 'tiktok-simulator.log')
  : '/tmp/tiktok-proxy.log';

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
  '.ico': 'image/x-icon'
};

var DEFAULT_CATEGORIES = [
  { id: 120, name: 'Đề xuất', icon: '🔥' },
  { id: 104, name: 'Hài hước', icon: '😂' },
  { id: 119, name: 'Ca hát & Nhảy', icon: '🎵' },
  { id: 105, name: 'Đời sống', icon: '🏡' },
  { id: 111, name: 'Ẩm thực', icon: '🍜' },
  { id: 113, name: 'Động vật', icon: '🐶' },
  { id: 103, name: 'Game', icon: '🎮' },
  { id: 100, name: 'Anime', icon: '🌸' },
  { id: 112, name: 'Thể thao', icon: '⚽' },
  { id: 108, name: 'Phim ảnh', icon: '🎬' },
  { id: 102, name: 'Làm đẹp', icon: '💄' },
  { id: 109, name: 'Thời trang', icon: '👗' },
  { id: 115, name: 'Xe cộ', icon: '🚗' },
  { id: 116, name: 'Giáo dục', icon: '📚' }
];

var cookieJar = {};
var cookieInitAt = 0;
var videoStreamMap = {};
var videoStreamOrder = [];
var MAX_VIDEO_CACHE = 260;

function writeLog(tag, msg) {
  var line = '[' + new Date().toISOString() + '] [' + tag + '] ' + msg + '\n';
  try { process.stdout.write(line); } catch (e) {}
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (e) {}
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

function sendJson(res, status, obj) {
  setCorsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function mergeCookies(setCookieHeader) {
  if (!Array.isArray(setCookieHeader)) return;
  for (var i = 0; i < setCookieHeader.length; i++) {
    var pair = String(setCookieHeader[i] || '').split(';')[0];
    var eq = pair.indexOf('=');
    if (eq > 0) {
      var k = pair.slice(0, eq).trim();
      var v = pair.slice(eq + 1).trim();
      if (k && v) cookieJar[k] = v;
    }
  }
}

function getCookieString() {
  var keys = Object.keys(cookieJar);
  var out = [];
  for (var i = 0; i < keys.length; i++) {
    out.push(keys[i] + '=' + cookieJar[keys[i]]);
  }
  return out.join('; ');
}

function decompressBody(buf, contentEncoding) {
  if (!buf || !buf.length) return buf;
  var enc = String(contentEncoding || '').toLowerCase();
  try {
    if (enc.indexOf('gzip') !== -1 || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
      return zlib.gunzipSync(buf);
    }
    if (enc.indexOf('deflate') !== -1) {
      return zlib.inflateSync(buf);
    }
  } catch (e) {}
  return buf;
}

// Node.js v8.12.0 compatible HTTPS getter (strictly uses parsed options object, NEVER https.get(url, opts, cb))
function httpsGetBuffer(targetUrl, extraHeaders, redirectsLeft) {
  redirectsLeft = typeof redirectsLeft === 'number' ? redirectsLeft : 4;
  return new Promise(function (resolve, reject) {
    var parsed;
    try {
      parsed = urlModule.parse(targetUrl);
    } catch (e) {
      return reject(new Error('Invalid URL'));
    }

    var isHttps = parsed.protocol !== 'http:';
    var client = isHttps ? https : http;
    var headers = {
      'User-Agent': UA,
      'Referer': 'https://www.tiktok.com/',
      'Accept': 'application/json, text/html, */*;q=0.8',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate'
    };
    var cStr = getCookieString();
    if (cStr) headers['Cookie'] = cStr;
    if (extraHeaders) {
      var hk = Object.keys(extraHeaders);
      for (var i = 0; i < hk.length; i++) headers[hk[i]] = extraHeaders[hk[i]];
    }

    var req = client.get({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.path || '/',
      family: 4,
      rejectUnauthorized: false,
      headers: headers
    }, function (res) {
      mergeCookies(res.headers['set-cookie']);
      var status = res.statusCode || 500;
      if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && res.headers.location && redirectsLeft > 0) {
        var nextUrl = urlModule.resolve(targetUrl, res.headers.location);
        res.resume();
        return httpsGetBuffer(nextUrl, extraHeaders, redirectsLeft - 1).then(resolve, reject);
      }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks);
        var buf = decompressBody(raw, res.headers['content-encoding']);
        resolve({ status: status, headers: res.headers, buf: buf });
      });
    });

    req.setTimeout(14000, function () {
      req.abort();
      reject(new Error('Upstream timeout'));
    });
    req.on('error', reject);
  });
}

async function ensureTikTokSession(forceRefresh) {
  var now = Date.now();
  if (!forceRefresh && cookieJar.ttwid && (now - cookieInitAt) < 12 * 60 * 1000) {
    return;
  }
  await httpsGetBuffer('https://www.tiktok.com/explore', {}, 4);
  cookieInitAt = now;
  writeLog('SESSION', 'Refreshed TikTok cookies: ' + Object.keys(cookieJar).join(','));
}

function pickVideoUrls(videoObj) {
  var urls = [];
  var seen = {};
  function addUrl(u) {
    if (typeof u === 'string' && u.indexOf('http') === 0 && !seen[u]) {
      seen[u] = true;
      urls.push(u);
    }
  }

  // Priority 1: H.264 MP4 streams (100% hardware-decoded & zero stutter on LG webOS 6.0!)
  var bitrates = Array.isArray(videoObj.bitrateInfo) ? videoObj.bitrateInfo : [];
  var h264List = [];
  for (var i = 0; i < bitrates.length; i++) {
    var b = bitrates[i];
    var codec = String((b && b.CodecType) || '').toLowerCase();
    if (codec.indexOf('h264') !== -1 && b.PlayAddr && Array.isArray(b.PlayAddr.UrlList)) {
      h264List.push(b);
    }
  }
  // Sort H.264 streams to prefer crisp 720p/540p around 1-2.5 Mbps (fast start on TV)
  h264List.sort(function (a, b) {
    var ba = Number(a.Bitrate || 0);
    var bb = Number(b.Bitrate || 0);
    return bb - ba;
  });
  for (var j = 0; j < h264List.length; j++) {
    var ulist = h264List[j].PlayAddr.UrlList;
    for (var k = 0; k < ulist.length; k++) addUrl(ulist[k]);
  }

  // Fallback: default playAddr / downloadAddr
  addUrl(videoObj.playAddr);
  addUrl(videoObj.downloadAddr);
  return urls;
}

function registerVideoStream(id, urls, cookieStr) {
  if (!id || !urls || !urls.length) return;
  if (!videoStreamMap[id]) {
    videoStreamOrder.push(id);
    while (videoStreamOrder.length > MAX_VIDEO_CACHE) {
      var oldest = videoStreamOrder.shift();
      delete videoStreamMap[oldest];
    }
  }
  videoStreamMap[id] = {
    urls: urls,
    cookie: cookieStr,
    at: Date.now()
  };
}

function mapVideoItem(it, hostPrefix, cookieStr) {
  if (!it || !it.id || !it.video) return null;
  var urls = pickVideoUrls(it.video);
  if (!urls.length) return null;

  var id = String(it.id);
  registerVideoStream(id, urls, cookieStr);

  var rawCover = (it.video.cover || it.video.originCover || it.video.dynamicCover || '');
  var rawAvatar = (it.author && (it.author.avatarThumb || it.author.avatarMedium)) || '';

  return {
    id: id,
    desc: String(it.desc || ''),
    duration: Number(it.video.duration || 0),
    width: Number(it.video.width || 576),
    height: Number(it.video.height || 1024),
    videoUrl: hostPrefix + '/proxy/video?id=' + encodeURIComponent(id),
    cover: rawCover ? (hostPrefix + '/proxy/img?url=' + encodeURIComponent(rawCover)) : '',
    author: {
      uniqueId: String((it.author && it.author.uniqueId) || 'tiktok'),
      nickname: String((it.author && it.author.nickname) || 'TikTok Creator'),
      avatar: rawAvatar ? (hostPrefix + '/proxy/img?url=' + encodeURIComponent(rawAvatar)) : '',
      verified: Boolean(it.author && it.author.verified)
    },
    music: {
      title: String((it.music && it.music.title) || 'Âm thanh gốc'),
      author: String((it.music && it.music.authorName) || '')
    },
    stats: {
      diggCount: Number((it.stats && it.stats.diggCount) || 0),
      commentCount: Number((it.stats && it.stats.commentCount) || 0),
      shareCount: Number((it.stats && it.stats.shareCount) || 0),
      playCount: Number((it.stats && it.stats.playCount) || 0)
    }
  };
}

async function handleFeed(req, res, catId, count) {
  var categoryType = Number(catId || 120);
  if (isNaN(categoryType) || categoryType <= 0) categoryType = 120;
  var reqCount = Math.max(8, Math.min(20, Number(count || 14)));
  var hostPrefix = 'http://' + (req.headers.host || ('127.0.0.1:' + PORT));

  try {
    await ensureTikTokSession(false);
    var apiUrl = 'https://www.tiktok.com/api/explore/item_list/?aid=1988&categoryType=' +
      categoryType + '&count=' + reqCount + '&device_platform=web_pc';

    var r = await httpsGetBuffer(apiUrl, {}, 3);
    var text = r.buf.toString('utf8');
    if (!text || text.charAt(0) !== '{') {
      await ensureTikTokSession(true);
      r = await httpsGetBuffer(apiUrl, {}, 3);
      text = r.buf.toString('utf8');
    }

    var parsed = JSON.parse(text);
    var rawList = Array.isArray(parsed.itemList) ? parsed.itemList : [];
    var cookieStr = getCookieString();
    var items = [];
    var seen = {};

    for (var i = 0; i < rawList.length; i++) {
      var mapped = mapVideoItem(rawList[i], hostPrefix, cookieStr);
      if (mapped && !seen[mapped.id]) {
        seen[mapped.id] = true;
        items.push(mapped);
      }
    }

    writeLog('FEED', 'cat=' + categoryType + ' -> ' + items.length + ' videos');
    sendJson(res, 200, {
      category: categoryType,
      count: items.length,
      items: items
    });
  } catch (err) {
    writeLog('FEED-ERR', 'cat=' + categoryType + ' -> ' + err.message);
    sendJson(res, 502, { error: err.message, items: [] });
  }
}

async function handleComments(req, res, videoId) {
  if (!videoId) return sendJson(res, 400, { error: 'Missing id', comments: [] });
  var hostPrefix = 'http://' + (req.headers.host || ('127.0.0.1:' + PORT));
  try {
    await ensureTikTokSession(false);
    var cmUrl = 'https://www.tiktok.com/api/comment/list/?aid=1988&aweme_id=' +
      encodeURIComponent(videoId) + '&count=25&cursor=0';
    var r = await httpsGetBuffer(cmUrl, {}, 2);
    var text = r.buf.toString('utf8');
    var parsed = text && text.charAt(0) === '{' ? JSON.parse(text) : {};
    var raw = Array.isArray(parsed.comments) ? parsed.comments : [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (!c || !c.text) continue;
      var u = c.user || {};
      var av = (u.avatar_thumb && Array.isArray(u.avatar_thumb.url_list) && u.avatar_thumb.url_list[0]) || '';
      out.push({
        id: String(c.cid || i),
        text: String(c.text || ''),
        likes: Number(c.digg_count || 0),
        createdAt: Number(c.create_time || 0),
        user: {
          nickname: String(u.nickname || u.unique_id || 'Người dùng TikTok'),
          uniqueId: String(u.unique_id || ''),
          avatar: av ? (hostPrefix + '/proxy/img?url=' + encodeURIComponent(av)) : ''
        }
      });
    }
    writeLog('COMMENTS', 'id=' + videoId + ' -> ' + out.length + ' comments');
    sendJson(res, 200, { id: videoId, total: Number(parsed.total || out.length), comments: out });
  } catch (err) {
    writeLog('COMMENTS-ERR', err.message);
    sendJson(res, 200, { id: videoId, total: 0, comments: [], error: err.message });
  }
}

function streamVideoAttempt(req, res, entry, urlIdx, redirectsLeft) {
  if (!entry || !entry.urls || urlIdx >= entry.urls.length) {
    if (!res.headersSent) {
      setCorsHeaders(res);
      res.writeHead(502);
      res.end('Video stream unavailable');
    }
    return;
  }

  var targetUrl = entry.urls[urlIdx];
  var parsed;
  try {
    parsed = urlModule.parse(targetUrl);
  } catch (e) {
    return streamVideoAttempt(req, res, entry, urlIdx + 1, 3);
  }

  var isHttps = parsed.protocol !== 'http:';
  var client = isHttps ? https : http;
  var fwdHeaders = {
    'User-Agent': UA,
    'Referer': 'https://www.tiktok.com/',
    'Origin': 'https://www.tiktok.com',
    'Cookie': entry.cookie || getCookieString()
  };
  if (req.headers.range) {
    fwdHeaders['Range'] = req.headers.range;
  }

  var upReq = client.request({
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.path || '/',
    method: 'GET',
    family: 4,
    rejectUnauthorized: false,
    headers: fwdHeaders
  }, function (upRes) {
    var status = upRes.statusCode || 500;
    if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && upRes.headers.location && redirectsLeft > 0) {
      var nextEntry = {
        urls: [urlModule.resolve(targetUrl, upRes.headers.location)],
        cookie: entry.cookie
      };
      upRes.resume();
      return streamVideoAttempt(req, res, nextEntry, 0, redirectsLeft - 1);
    }

    if (status >= 400 && urlIdx + 1 < entry.urls.length) {
      upRes.resume();
      return streamVideoAttempt(req, res, entry, urlIdx + 1, 3);
    }

    setCorsHeaders(res);
    var outHeaders = {
      'Content-Type': upRes.headers['content-type'] || 'video/mp4',
      'Accept-Ranges': upRes.headers['accept-ranges'] || 'bytes',
      'Cache-Control': 'public, max-age=600'
    };
    if (upRes.headers['content-length']) outHeaders['Content-Length'] = upRes.headers['content-length'];
    if (upRes.headers['content-range']) outHeaders['Content-Range'] = upRes.headers['content-range'];

    res.writeHead(status, outHeaders);
    upRes.pipe(res);
  });

  upReq.setTimeout(15000, function () {
    upReq.abort();
  });

  upReq.on('error', function (err) {
    writeLog('VIDEO-ERR', 'idx=' + urlIdx + ' ' + err.message);
    if (!res.headersSent && urlIdx + 1 < entry.urls.length) {
      return streamVideoAttempt(req, res, entry, urlIdx + 1, 3);
    }
    if (!res.headersSent) {
      setCorsHeaders(res);
      res.writeHead(502);
      res.end('Video proxy error');
    }
  });

  req.on('close', function () {
    if (!res.finished && upReq && upReq.abort) {
      try { upReq.abort(); } catch (e) {}
    }
  });

  upReq.end();
}

function handleImageProxy(req, res, targetUrlStr, redirectsLeft) {
  redirectsLeft = typeof redirectsLeft === 'number' ? redirectsLeft : 3;
  if (!targetUrlStr || targetUrlStr.indexOf('http') !== 0) {
    res.writeHead(400);
    return res.end('Bad img url');
  }
  var parsed;
  try {
    parsed = urlModule.parse(targetUrlStr);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad img url');
  }
  var isHttps = parsed.protocol !== 'http:';
  var client = isHttps ? https : http;
  var upReq = client.get({
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.path || '/',
    family: 4,
    rejectUnauthorized: false,
    headers: {
      'User-Agent': UA,
      'Referer': 'https://www.tiktok.com/'
    }
  }, function (upRes) {
    var status = upRes.statusCode || 500;
    if ((status === 301 || status === 302 || status === 307 || status === 308) && upRes.headers.location && redirectsLeft > 0) {
      upRes.resume();
      return handleImageProxy(req, res, urlModule.resolve(targetUrlStr, upRes.headers.location), redirectsLeft - 1);
    }
    setCorsHeaders(res);
    res.writeHead(status, {
      'Content-Type': upRes.headers['content-type'] || 'image/jpeg',
      'Cache-Control': 'public, max-age=3600'
    });
    upRes.pipe(res);
  });
  upReq.setTimeout(10000, function () { upReq.abort(); });
  upReq.on('error', function () {
    if (!res.headersSent) { res.writeHead(502); res.end(); }
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

  if (pathname === '/api/health') {
    return sendJson(res, 200, { status: 'TikTok TV Proxy Running', port: PORT });
  }

  if (pathname === '/api/categories') {
    return sendJson(res, 200, { categories: DEFAULT_CATEGORIES });
  }

  if (pathname === '/api/feed') {
    return handleFeed(req, res, parsed.query && parsed.query.cat, parsed.query && parsed.query.count);
  }

  if (pathname === '/api/comments') {
    return handleComments(req, res, parsed.query && parsed.query.id);
  }

  if (pathname === '/proxy/video') {
    var vidId = (parsed.query && parsed.query.id) || '';
    var entry = videoStreamMap[vidId];
    if (!entry) {
      setCorsHeaders(res);
      res.writeHead(404);
      return res.end('Video expired');
    }
    return streamVideoAttempt(req, res, entry, 0, 3);
  }

  if (pathname === '/proxy/img') {
    return handleImageProxy(req, res, (parsed.query && parsed.query.url) || '', 3);
  }

  if (pathname === '/api/log' && req.method === 'POST') {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      writeLog('CLIENT', Buffer.concat(chunks).toString('utf8'));
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // Static files for browser / Simulator
  var relFile = pathname === '/' ? '/index.html' : pathname;
  relFile = path.normalize(relFile).replace(/^(\.\.[/\\])+/, '');
  var fullPath = path.join(__dirname, relFile);
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    var ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(fullPath).pipe(res);
  } else {
    sendJson(res, 200, { status: 'TikTok TV Proxy Running', port: PORT });
  }
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
    writeLog('BOOT', 'Port ' + PORT + ' already listening — reusing existing TikTok Proxy.');
    markReady();
  } else {
    writeLog('BOOT-ERR', err ? err.message : String(err));
    markReady();
  }
});

server.listen(PORT, '127.0.0.1', function () {
  writeLog('BOOT', 'TikTok TV Server listening on http://127.0.0.1:' + PORT);
  markReady();
});

module.exports = {
  PORT: PORT,
  server: server,
  whenReady: whenReady
};
