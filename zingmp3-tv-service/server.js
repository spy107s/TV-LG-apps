'use strict';

var http = require('http');
var https = require('https');
var crypto = require('crypto');
var dns = require('dns');
var urlModule = require('url');
var querystring = require('querystring');
var zlib = require('zlib');
var fs = require('fs');
var path = require('path');

if (dns.setDefaultResultOrder) {
  try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}
}

var PORT = Number(process.env.PORT || 5030);
var ZMP3_HOST = 'zingmp3.vn';
var API_KEY = '88265e23d4284f25963e6eedac8fbfa3';
var SECRET_KEY = '2aa2d1c561e809b267f3638c4a307aab';
var VERSION = '1.6.40';
function loadLocalGiphyKey() {
  var candidates = [
    path.join(__dirname, 'giphy.local.json'),
    path.resolve(__dirname, '..', 'zingmp3-tv-app', 'giphy.local.json'),
    '/media/developer/apps/usr/palm/applications/com.giadinh.zingmp3tv/giphy.local.json'
  ];
  for (var i = 0; i < candidates.length; i++) {
    try {
      if (fs.existsSync(candidates[i])) {
        var j = JSON.parse(fs.readFileSync(candidates[i], 'utf8'));
        if (j && j.apiKey) return String(j.apiKey).trim();
      }
    } catch (e) {}
  }
  return '';
}

var GIPHY_API_KEY = process.env.GIPHY_API_KEY || loadLocalGiphyKey();
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

var LOG_FILE = process.platform === 'win32'
  ? path.resolve(__dirname, '..', 'zingmp3-simulator.log')
  : '/tmp/zingmp3-proxy.log';

var cachedCookie = '';
var cachedCookieAt = 0;
var cachedWeather = null;
var cachedWeatherAt = 0;
var giphyCache = {};
var giphyRateLimitedUntil = 0;

var MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

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

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function hmac512(str, key) {
  return crypto.createHmac('sha512', key).update(Buffer.from(str, 'utf8')).digest('hex');
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

function httpsGetBuffer(hostname, pathStr, headers) {
  return new Promise(function (resolve, reject) {
    var req = https.get({
      hostname: hostname,
      path: pathStr,
      family: 4,
      rejectUnauthorized: false,
      headers: Object.assign({
        'User-Agent': UA,
        'Referer': 'https://zingmp3.vn/',
        'Accept-Encoding': 'gzip, deflate'
      }, headers || {})
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var rawBuf = Buffer.concat(chunks);
        var buf = decompressBody(rawBuf, res.headers['content-encoding']);
        resolve({ status: res.statusCode || 500, headers: res.headers, buf: buf });
      });
    });
    req.setTimeout(14000, function () {
      req.abort();
      reject(new Error('Upstream timeout: ' + pathStr.slice(0, 50)));
    });
    req.on('error', reject);
  });
}

async function getZingCookie(forceRefresh) {
  var now = Date.now();
  if (!forceRefresh && cachedCookie && (now - cachedCookieAt) < 10 * 60 * 1000) {
    return cachedCookie;
  }
  var r = await httpsGetBuffer(ZMP3_HOST, '/', {});
  var sc = r.headers['set-cookie'];
  if (Array.isArray(sc) && sc.length > 0) {
    cachedCookie = sc.map(function (c) { return String(c).split(';')[0]; }).join('; ');
    cachedCookieAt = now;
  }
  return cachedCookie;
}

async function zingApiRequest(apiPath, extraParams, sigTemplate, isRetry) {
  var cookie = await getZingCookie(Boolean(isRetry));
  var ctime = String(Math.floor(Date.now() / 1000));
  var sigStr = sigTemplate.replace('{ctime}', ctime);
  var sig = hmac512(apiPath + sha256(sigStr), SECRET_KEY);

  var params = Object.assign({}, extraParams || {}, {
    ctime: ctime,
    version: VERSION,
    apiKey: API_KEY,
    sig: sig
  });

  var fullPath = apiPath + '?' + querystring.stringify(params);
  var r = await httpsGetBuffer(ZMP3_HOST, fullPath, { Cookie: cookie });
  var json = JSON.parse(r.buf.toString('utf8'));

  if (json && json.err !== 0 && !isRetry && (json.err === -1023 || json.err === -201)) {
    return zingApiRequest(apiPath, extraParams, sigTemplate, true);
  }
  return json;
}

function normalizeSong(s) {
  if (!s || !s.encodeId) return null;
  return {
    id: s.encodeId,
    title: s.title || 'Không rõ tên',
    artists: s.artistsNames || 'Nhiều nghệ sĩ',
    thumbnail: s.thumbnailM || s.thumbnail || '',
    duration: Number(s.duration || 0),
    isVip: Number(s.streamingStatus || 1) !== 1,
    album: (s.album && s.album.title) || '',
    releaseDate: s.releaseDate || 0
  };
}

function normalizePlaylist(p) {
  if (!p || !p.encodeId) return null;
  return {
    id: p.encodeId,
    title: p.title || 'Playlist',
    subtitle: p.sortDescription || p.artistsNames || '',
    thumbnail: p.thumbnailM || p.thumbnail || ''
  };
}

function formatLyricSentences(lyricData) {
  var out = [];
  if (!lyricData) return out;

  if (Array.isArray(lyricData.sentences) && lyricData.sentences.length > 0) {
    for (var i = 0; i < lyricData.sentences.length; i++) {
      var sent = lyricData.sentences[i];
      var words = sent && Array.isArray(sent.words) ? sent.words : [];
      if (!words.length) continue;
      var textParts = [];
      var startMs = Number(words[0].startTime || 0);
      var endMs = Number(words[words.length - 1].endTime || (startMs + 3000));
      for (var w = 0; w < words.length; w++) {
        if (words[w] && words[w].data) textParts.push(words[w].data);
      }
      var lineText = textParts.join(' ').trim();
      if (lineText) {
        out.push({
          time: startMs / 1000,
          endTime: endMs / 1000,
          text: lineText
        });
      }
    }
  }
  return out;
}

// ===== ROUTE HANDLERS =====
async function handleHome(req, res) {
  try {
    var json = await zingApiRequest(
      '/api/v2/page/get/home',
      { page: '1', count: '30', segmentId: '-1' },
      'count=30ctime={ctime}page=1version=' + VERSION
    );

    var items = (json && json.data && Array.isArray(json.data.items)) ? json.data.items : [];
    var newReleases = { all: [], vPop: [], others: [] };
    var newReleaseChart = [];
    var playlistSections = [];

    for (var i = 0; i < items.length; i++) {
      var sec = items[i];
      if (!sec || sec.sectionType === 'adBanner') continue;

      if (sec.sectionType === 'new-release' && sec.items) {
        if (Array.isArray(sec.items.all)) newReleases.all = sec.items.all.map(normalizeSong).filter(Boolean).slice(0, 24);
        if (Array.isArray(sec.items.vPop)) newReleases.vPop = sec.items.vPop.map(normalizeSong).filter(Boolean).slice(0, 24);
        if (Array.isArray(sec.items.others)) newReleases.others = sec.items.others.map(normalizeSong).filter(Boolean).slice(0, 24);
      } else if (sec.sectionType === 'newReleaseChart' && Array.isArray(sec.items)) {
        newReleaseChart = sec.items.map(normalizeSong).filter(Boolean).slice(0, 12);
      } else if (sec.sectionType === 'playlist' && Array.isArray(sec.items) && sec.items.length > 0) {
        var pls = sec.items.map(normalizePlaylist).filter(Boolean);
        if (pls.length > 0) {
          playlistSections.push({
            title: sec.title || 'Tuyển tập chọn lọc',
            items: pls.slice(0, 12)
          });
        }
      }
    }

    writeLog('API', 'GET /api/home -> newReleases:' + newReleases.all.length + ', sections:' + playlistSections.length);
    sendJson(res, 200, {
      newReleases: newReleases,
      newReleaseChart: newReleaseChart,
      playlistSections: playlistSections
    });
  } catch (err) {
    writeLog('API-ERR', 'GET /api/home -> ' + err.message);
    sendJson(res, 502, { error: err.message });
  }
}

async function handleChart(req, res) {
  try {
    var json = await zingApiRequest('/api/v2/page/get/chart-home', {}, 'ctime={ctime}version=' + VERSION);
    var d = (json && json.data) || {};
    var rtItems = (d.RTChart && Array.isArray(d.RTChart.items)) ? d.RTChart.items.map(normalizeSong).filter(Boolean) : [];
    var wc = d.weekChart || {};
    var weekCharts = {
      vn: (wc.vn && Array.isArray(wc.vn.items)) ? wc.vn.items.map(normalizeSong).filter(Boolean) : [],
      us: (wc.us && Array.isArray(wc.us.items)) ? wc.us.items.map(normalizeSong).filter(Boolean) : [],
      korea: (wc.korea && Array.isArray(wc.korea.items)) ? wc.korea.items.map(normalizeSong).filter(Boolean) : []
    };

    writeLog('API', 'GET /api/chart -> rt:' + rtItems.length + ', vn:' + weekCharts.vn.length);
    sendJson(res, 200, {
      rtChart: rtItems.slice(0, 50),
      weekCharts: weekCharts
    });
  } catch (err) {
    writeLog('API-ERR', 'GET /api/chart -> ' + err.message);
    sendJson(res, 502, { error: err.message });
  }
}

async function handleTop100(req, res) {
  try {
    var json = await zingApiRequest('/api/v2/page/get/top-100', {}, 'ctime={ctime}version=' + VERSION);
    var raw = (json && Array.isArray(json.data)) ? json.data : [];
    var groups = [];
    for (var i = 0; i < raw.length; i++) {
      var g = raw[i];
      var pls = (g && Array.isArray(g.items)) ? g.items.map(normalizePlaylist).filter(Boolean) : [];
      if (pls.length > 0) {
        groups.push({ title: g.title || 'Top 100', items: pls });
      }
    }
    writeLog('API', 'GET /api/top100 -> groups:' + groups.length);
    sendJson(res, 200, { groups: groups });
  } catch (err) {
    writeLog('API-ERR', 'GET /api/top100 -> ' + err.message);
    sendJson(res, 502, { error: err.message });
  }
}

function normalizeHubTopic(item) {
  if (!item || !item.encodeId) return null;
  return {
    id: item.encodeId,
    title: item.title || 'Chủ đề',
    cover: item.thumbnailHasText || item.thumbnailR || item.cover || item.thumbnail || '',
    description: item.description || ''
  };
}

async function handleHubHome(req, res) {
  try {
    var json = await zingApiRequest('/api/v2/page/get/hub-home', {}, 'ctime={ctime}version=' + VERSION);
    var d = (json && json.data) || {};
    var topics = Array.isArray(d.topic) ? d.topic.map(normalizeHubTopic).filter(Boolean) : [];
    var nations = Array.isArray(d.nations) ? d.nations.map(normalizeHubTopic).filter(Boolean) : [];
    var genres = [];
    if (Array.isArray(d.genre)) {
      for (var i = 0; i < d.genre.length; i++) {
        var g = d.genre[i];
        if (!g || !g.encodeId) continue;
        var pls = Array.isArray(g.playlists) ? g.playlists.map(normalizePlaylist).filter(Boolean) : [];
        genres.push({
          id: g.encodeId,
          title: g.title || 'Thể loại',
          cover: g.thumbnailR || g.cover || g.thumbnail || '',
          playlists: pls.slice(0, 10)
        });
      }
    }
    writeLog('API', 'GET /api/hub -> topics:' + topics.length + ', nations:' + nations.length + ', genres:' + genres.length);
    sendJson(res, 200, { topics: topics, nations: nations, genres: genres });
  } catch (err) {
    writeLog('API-ERR', 'GET /api/hub -> ' + err.message);
    sendJson(res, 502, { error: err.message });
  }
}

async function handleHubDetail(req, res, id) {
  if (!id) return sendJson(res, 400, { error: 'Missing id' });
  try {
    var json = await zingApiRequest('/api/v2/page/get/hub-detail', { id: id }, 'ctime={ctime}id=' + id + 'version=' + VERSION);
    var d = (json && json.data) || {};
    var rawSections = Array.isArray(d.sections) ? d.sections : [];
    var playlistSections = [];
    var songs = [];
    for (var i = 0; i < rawSections.length; i++) {
      var sec = rawSections[i];
      if (!sec || !Array.isArray(sec.items) || !sec.items.length) continue;
      if (sec.sectionType === 'playlist') {
        var pls = sec.items.map(normalizePlaylist).filter(Boolean);
        if (pls.length > 0) {
          playlistSections.push({ title: sec.title || 'Tuyển tập', items: pls });
        }
      } else if (sec.sectionType === 'song' && !songs.length) {
        songs = sec.items.map(normalizeSong).filter(Boolean).slice(0, 20);
      }
    }
    writeLog('API', 'GET /api/hub-detail?id=' + id + ' -> sections:' + playlistSections.length + ', songs:' + songs.length);
    sendJson(res, 200, {
      id: d.encodeId || id,
      title: d.title || 'Chủ đề',
      cover: d.cover || d.thumbnailR || '',
      description: d.description || '',
      playlistSections: playlistSections,
      songs: songs
    });
  } catch (err) {
    writeLog('API-ERR', 'GET /api/hub-detail -> ' + err.message);
    sendJson(res, 502, { error: err.message });
  }
}

async function handlePlaylist(req, res, id) {
  if (!id) return sendJson(res, 400, { error: 'Missing id' });
  try {
    var json = await zingApiRequest('/api/v2/page/get/playlist', { id: id }, 'ctime={ctime}id=' + id + 'version=' + VERSION);
    var d = (json && json.data) || {};
    var songs = (d.song && Array.isArray(d.song.items)) ? d.song.items.map(normalizeSong).filter(Boolean) : [];
    writeLog('API', 'GET /api/playlist?id=' + id + ' -> songs:' + songs.length);
    sendJson(res, 200, {
      id: d.encodeId || id,
      title: d.title || 'Playlist',
      description: d.sortDescription || d.description || '',
      thumbnail: d.thumbnailM || d.thumbnail || '',
      artists: d.artistsNames || '',
      songs: songs
    });
  } catch (err) {
    writeLog('API-ERR', 'GET /api/playlist -> ' + err.message);
    sendJson(res, 502, { error: err.message });
  }
}

async function handleSearch(req, res, q) {
  if (!q) return sendJson(res, 200, { songs: [], playlists: [] });
  try {
    var json = await zingApiRequest('/api/v2/search/multi', { q: q }, 'ctime={ctime}version=' + VERSION);
    var d = (json && json.data) || {};
    var songs = Array.isArray(d.songs) ? d.songs.map(normalizeSong).filter(Boolean) : [];
    var playlists = Array.isArray(d.playlists) ? d.playlists.map(normalizePlaylist).filter(Boolean) : [];
    writeLog('API', 'GET /api/search?q=' + q + ' -> songs:' + songs.length + ', playlists:' + playlists.length);
    sendJson(res, 200, { songs: songs, playlists: playlists });
  } catch (err) {
    writeLog('API-ERR', 'GET /api/search -> ' + err.message);
    sendJson(res, 502, { error: err.message, songs: [], playlists: [] });
  }
}

async function handleSong(req, res, id) {
  if (!id) return sendJson(res, 400, { error: 'Missing id' });
  try {
    var results = await Promise.all([
      zingApiRequest('/api/v2/song/get/streaming', { id: id }, 'ctime={ctime}id=' + id + 'version=' + VERSION),
      zingApiRequest('/api/v2/lyric/get/lyric', { id: id }, 'ctime={ctime}id=' + id + 'version=' + VERSION).catch(function () { return {}; })
    ]);

    var streamJson = results[0] || {};
    var lyricJson = results[1] || {};
    var streamData = streamJson.data || {};
    var rawUrl = '';
    var quality = '';

    if (typeof streamData['320'] === 'string' && streamData['320'].indexOf('http') === 0) {
      rawUrl = streamData['320'];
      quality = '320kbps';
    } else if (typeof streamData['128'] === 'string' && streamData['128'].indexOf('http') === 0) {
      rawUrl = streamData['128'];
      quality = '128kbps';
    }

    var hostPrefix = 'http://' + (req.headers.host || ('127.0.0.1:' + PORT));
    var proxyUrl = rawUrl ? (hostPrefix + '/proxy/audio?url=' + encodeURIComponent(rawUrl)) : '';
    var lyrics = formatLyricSentences(lyricJson.data);

    writeLog('SONG', 'id=' + id + ' -> ' + (rawUrl ? quality : ('NO_STREAM err=' + streamJson.err)) + ', lyrics=' + lyrics.length);
    sendJson(res, 200, {
      id: id,
      playable: Boolean(rawUrl),
      vipOnly: !rawUrl && (streamJson.err === -1110 || streamJson.err === -1150 || streamData['128'] === 'VIP'),
      msg: streamJson.msg || '',
      quality: quality,
      audioUrl: proxyUrl,
      lyrics: lyrics
    });
  } catch (err) {
    writeLog('SONG-ERR', 'id=' + id + ' -> ' + err.message);
    sendJson(res, 502, { playable: false, error: err.message });
  }
}

function mapWmoWeather(code) {
  var c = Number(code);
  if (c === 0) return { icon: '☀️', text: 'Trời quang đãng' };
  if (c === 1) return { icon: '🌤️', text: 'Chủ yếu nắng' };
  if (c === 2) return { icon: '⛅', text: 'Có mây rải rác' };
  if (c === 3) return { icon: '☁️', text: 'Nhiều mây' };
  if (c === 45 || c === 48) return { icon: '🌫️', text: 'Có sương mù' };
  if (c >= 51 && c <= 57) return { icon: '🌦️', text: 'Mưa phùn nhẹ' };
  if (c >= 61 && c <= 65) return { icon: '🌧️', text: 'Trời có mưa' };
  if (c >= 66 && c <= 67) return { icon: '🌧️', text: 'Mưa lạnh' };
  if (c >= 80 && c <= 82) return { icon: '🌦️', text: 'Mưa rào' };
  if (c >= 95 && c <= 99) return { icon: '⛈️', text: 'Mưa dông' };
  return { icon: '🌤️', text: 'Thời tiết ôn hòa' };
}

async function handleWeather(req, res) {
  var now = Date.now();
  if (cachedWeather && (now - cachedWeatherAt) < 15 * 60 * 1000) {
    return sendJson(res, 200, cachedWeather);
  }
  try {
    var apiPath = '/v1/forecast?latitude=10.9465&longitude=106.8235&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FHo_Chi_Minh&forecast_days=1';
    var r = await httpsGetBuffer('api.open-meteo.com', apiPath, { 'Referer': '' });
    var raw = JSON.parse(r.buf.toString('utf8'));
    var cur = raw.current || {};
    var daily = raw.daily || {};
    var mapped = mapWmoWeather(cur.weather_code);
    var out = {
      city: 'Biên Hòa, Đồng Nai',
      temp: typeof cur.temperature_2m === 'number' ? Math.round(cur.temperature_2m) : null,
      feelsLike: typeof cur.apparent_temperature === 'number' ? Math.round(cur.apparent_temperature) : null,
      humidity: typeof cur.relative_humidity_2m === 'number' ? Math.round(cur.relative_humidity_2m) : null,
      wind: typeof cur.wind_speed_10m === 'number' ? Math.round(cur.wind_speed_10m) : null,
      tempMax: Array.isArray(daily.temperature_2m_max) ? Math.round(daily.temperature_2m_max[0]) : null,
      tempMin: Array.isArray(daily.temperature_2m_min) ? Math.round(daily.temperature_2m_min[0]) : null,
      rainChance: Array.isArray(daily.precipitation_probability_max) ? Math.round(daily.precipitation_probability_max[0]) : null,
      icon: mapped.icon,
      desc: mapped.text,
      updatedAt: new Date().toISOString()
    };
    cachedWeather = out;
    cachedWeatherAt = now;
    writeLog('API', 'GET /api/weather -> Biên Hòa ' + out.temp + 'C (' + out.desc + ')');
    sendJson(res, 200, out);
  } catch (err) {
    writeLog('WEATHER-ERR', err.message);
    if (cachedWeather) return sendJson(res, 200, cachedWeather);
    sendJson(res, 502, { city: 'Biên Hòa, Đồng Nai', error: err.message });
  }
}

function getAmbientGifDirs() {
  var dirs = [
    path.join(__dirname, 'gifs'),
    path.resolve(__dirname, '..', 'zingmp3-tv-app', 'gifs'),
    '/media/developer/apps/usr/palm/applications/com.giadinh.zingmp3tv/gifs',
    '/media/internal/zingmp3-gifs'
  ];
  var seen = {};
  var valid = [];
  for (var i = 0; i < dirs.length; i++) {
    var d = path.normalize(dirs[i]);
    if (!seen[d]) {
      seen[d] = true;
      try {
        if (fs.existsSync(d) && fs.statSync(d).isDirectory()) valid.push(d);
      } catch (e) {}
    }
  }
  return valid;
}

function listAmbientGifs(hostPrefix) {
  var dirs = getAmbientGifDirs();
  var allowed = { '.gif': true, '.webp': true, '.png': true, '.jpg': true, '.jpeg': true };
  var files = [];
  var seenNames = {};
  for (var i = 0; i < dirs.length; i++) {
    var entries = [];
    try { entries = fs.readdirSync(dirs[i]); } catch (e) {}
    for (var j = 0; j < entries.length; j++) {
      var name = entries[j];
      var ext = path.extname(name).toLowerCase();
      if (!allowed[ext] || seenNames[name]) continue;
      seenNames[name] = true;
      files.push({
        type: 'image',
        source: 'local',
        name: name,
        url: hostPrefix + '/api/ambient-gif-file?name=' + encodeURIComponent(name)
      });
    }
  }
  return files;
}

var WALLPAPER_TOPIC_MAP = {
  'rainy': 'rain window',
  'lofi': 'lofi',
  'study': 'anime cafe',
  'cozy': 'fireplace',
  'ghibli-hd': 'studio ghibli'
};

async function handleAmbientMedia(req, res, topicKey) {
  var hostPrefix = 'http://' + (req.headers.host || ('127.0.0.1:' + PORT));
  var localItems = listAmbientGifs(hostPrefix);
  var topic = String(topicKey || 'rainy').toLowerCase();

  // Explicit offline Ghibli static library
  if (topic === 'local') {
    return sendJson(res, 200, {
      source: 'local',
      topic: 'local',
      items: localItems
    });
  }

  var query = WALLPAPER_TOPIC_MAP[topic] || 'rain window';
  var now = Date.now();

  // If rate-limited recently (within 15 min), immediately fall back to local Ghibli library
  if (giphyRateLimitedUntil > now) {
    writeLog('WALLPAPER', 'Rate-limit cooldown active -> serving local Ghibli library (' + localItems.length + ')');
    return sendJson(res, 200, {
      source: 'local',
      fallbackReason: 'rate_limit',
      topic: topic,
      items: localItems
    });
  }

  // Return 2-hour cached HD/2K/4K static wallpapers if fresh
  var cached = giphyCache[query];
  if (cached && (now - cached.at) < 2 * 60 * 60 * 1000 && cached.items.length > 0) {
    return sendJson(res, 200, {
      source: 'wallhaven',
      cached: true,
      topic: topic,
      query: query,
      items: cached.items
    });
  }

  // Priority 1: Wallhaven Public Static Wallpaper API (TRUE 1920x1080+ Full HD / 2K / 4K, 16:9, SFW)
  // Note: GIPHY API has ZERO static images >= 1280px (stills are capped at 480-900px) and its HD MP4
  // conflicts with <audio> on LG webOS TV. Wallhaven delivers crisp 1080p-4K static JPG/PNG with zero conflict!
  try {
    var qs = querystring.stringify({
      q: query,
      atleast: '1920x1080',
      ratios: '16x9',
      purity: '100',
      sorting: 'favorites',
      page: '1'
    });
    var r = await httpsGetBuffer('wallhaven.cc', '/api/v1/search?' + qs, { 'Referer': '' });

    if (r.status === 429 || r.status === 403) {
      giphyRateLimitedUntil = now + 15 * 60 * 1000;
      writeLog('WALLPAPER-LIMIT', 'HTTP ' + r.status + ' rate limit -> falling back to local Ghibli library');
      return sendJson(res, 200, {
        source: 'local',
        fallbackReason: 'rate_limit',
        topic: topic,
        items: localItems
      });
    }

    if (r.status !== 200) {
      throw new Error('Wallhaven HTTP ' + r.status);
    }

    var parsed = JSON.parse(r.buf.toString('utf8'));
    var raw = (parsed && Array.isArray(parsed.data)) ? parsed.data : [];
    var hdItems = [];

    for (var i = 0; i < raw.length; i++) {
      var w = raw[i];
      if (!w || !w.path) continue;
      var dimX = Number(w.dimension_x || 0);
      var dimY = Number(w.dimension_y || 0);
      var sizeBytes = Number(w.file_size || 0);
      // Strict Full HD+ (>= 1920x1080) static images under 4.5MB for fast, crisp TV display
      if (dimX >= 1920 && dimY >= 1080 && (!sizeBytes || sizeBytes <= 4.5 * 1024 * 1024)) {
        hdItems.push({
          type: 'image',
          format: String(w.file_type || 'image/jpeg').replace('image/', ''),
          source: 'wallhaven',
          quality: dimX + 'x' + dimY,
          name: w.id,
          url: w.path
        });
      }
    }

    if (hdItems.length > 0) {
      giphyCache[query] = { at: now, items: hdItems };
      writeLog('WALLPAPER', 'query="' + query + '" -> ' + hdItems.length + ' static FullHD/2K/4K images');
      return sendJson(res, 200, {
        source: 'wallhaven',
        cached: false,
        topic: topic,
        query: query,
        items: hdItems
      });
    }

    throw new Error('No FullHD static wallpaper results');
  } catch (err) {
    writeLog('WALLPAPER-ERR', err.message + ' -> falling back to local Ghibli library');
    return sendJson(res, 200, {
      source: 'local',
      fallbackReason: 'error',
      topic: topic,
      items: localItems
    });
  }
}

function handleAmbientGifFile(req, res, fileName) {
  var safeName = path.basename(String(fileName || ''));
  if (!safeName) { res.writeHead(400); return res.end('Bad filename'); }
  var dirs = getAmbientGifDirs();
  for (var i = 0; i < dirs.length; i++) {
    var full = path.join(dirs[i], safeName);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      var ext = path.extname(full).toLowerCase();
      setCorsHeaders(res);
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600'
      });
      return fs.createReadStream(full).pipe(res);
    }
  }
  res.writeHead(404);
  res.end('Not found');
}

function handleAudioProxy(req, res, targetUrlStr, redirectsLeft) {
  redirectsLeft = typeof redirectsLeft === 'number' ? redirectsLeft : 5;
  if (!targetUrlStr || redirectsLeft <= 0) {
    res.writeHead(400);
    return res.end('Invalid audio url');
  }

  var parsed;
  try {
    parsed = urlModule.parse(targetUrlStr);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad url');
  }

  var isHttps = parsed.protocol === 'https:';
  var client = isHttps ? https : http;
  var fwdHeaders = {
    'User-Agent': UA,
    'Referer': 'https://zingmp3.vn/'
  };
  if (req.headers.range) {
    fwdHeaders['Range'] = req.headers.range;
  }

  var upReq = client.request({
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.path || '/',
    method: 'GET',
    headers: fwdHeaders,
    family: 4,
    rejectUnauthorized: false
  }, function (upRes) {
    var status = upRes.statusCode || 500;
    if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && upRes.headers.location) {
      var nextUrl = urlModule.resolve(targetUrlStr, upRes.headers.location);
      upRes.resume();
      return handleAudioProxy(req, res, nextUrl, redirectsLeft - 1);
    }

    setCorsHeaders(res);
    var outHeaders = {
      'Content-Type': upRes.headers['content-type'] || 'audio/mpeg',
      'Accept-Ranges': upRes.headers['accept-ranges'] || 'bytes',
      'Cache-Control': 'public, max-age=1800'
    };
    if (upRes.headers['content-length']) outHeaders['Content-Length'] = upRes.headers['content-length'];
    if (upRes.headers['content-range']) outHeaders['Content-Range'] = upRes.headers['content-range'];

    res.writeHead(status, outHeaders);
    upRes.pipe(res);
  });

  upReq.on('error', function (err) {
    writeLog('AUDIO-ERR', err.message);
    if (!res.headersSent) {
      setCorsHeaders(res);
      res.writeHead(502);
      res.end('Audio proxy error');
    }
  });

  req.on('close', function () {
    if (!res.finished && upReq && upReq.abort) {
      try { upReq.abort(); } catch (e) {}
    }
  });

  upReq.end();
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
    return sendJson(res, 200, { status: 'Zing MP3 TV Proxy Running', port: PORT });
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

  if (pathname === '/api/home') return handleHome(req, res);
  if (pathname === '/api/chart') return handleChart(req, res);
  if (pathname === '/api/top100') return handleTop100(req, res);
  if (pathname === '/api/hub') return handleHubHome(req, res);
  if (pathname === '/api/hub-detail') return handleHubDetail(req, res, (parsed.query && parsed.query.id) || '');
  if (pathname === '/api/playlist') return handlePlaylist(req, res, (parsed.query && parsed.query.id) || '');
  if (pathname === '/api/search') return handleSearch(req, res, (parsed.query && parsed.query.q) || '');
  if (pathname === '/api/song') return handleSong(req, res, (parsed.query && parsed.query.id) || '');
  if (pathname === '/api/weather') return handleWeather(req, res);
  if (pathname === '/api/ambient-media') {
    return handleAmbientMedia(req, res, parsed.query && parsed.query.topic);
  }
  if (pathname === '/api/ambient-gifs') {
    var hp = 'http://' + (req.headers.host || ('127.0.0.1:' + PORT));
    return sendJson(res, 200, { gifs: listAmbientGifs(hp) });
  }
  if (pathname === '/api/ambient-gif-file') {
    return handleAmbientGifFile(req, res, parsed.query && parsed.query.name);
  }
  if (pathname === '/proxy/audio') return handleAudioProxy(req, res, (parsed.query && parsed.query.url) || '', 5);

  // Static files for browser / local preview
  var relFile = pathname === '/' ? '/index.html' : pathname;
  relFile = path.normalize(relFile).replace(/^(\.\.[/\\])+/, '');
  var fullPath = path.join(__dirname, relFile);
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    var ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(fullPath).pipe(res);
  } else {
    sendJson(res, 200, { status: 'Zing MP3 TV Proxy Running', port: PORT });
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
    writeLog('BOOT', 'Port ' + PORT + ' already listening — reusing existing Zing MP3 Proxy.');
    markReady();
  } else {
    writeLog('BOOT-ERR', err ? err.message : String(err));
    markReady();
  }
});

server.listen(PORT, '127.0.0.1', function () {
  writeLog('BOOT', 'Zing MP3 TV Server listening on http://127.0.0.1:' + PORT);
  markReady();
});

module.exports = {
  PORT: PORT,
  server: server,
  whenReady: whenReady
};
