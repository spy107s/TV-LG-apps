'use strict';

var urlModule = require('url');

var AD_DOMAIN_PATTERNS = [
  'streamxx.net',
  'explclk.com',
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google',
  'googletagmanager.com',
  'google-analytics.com',
  'popads.net',
  'popcash.net',
  'exoclick.com',
  'propellerads.com',
  'adsterra.com',
  'mgid.com',
  'taboola.com',
  'outbrain.com',
  'juicyads.com',
  'trafficjunky.net',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'criteo.com',
  'bet88',
  'fb88',
  'jun88',
  'hi88',
  'kubet',
  '789bet',
  'okvip',
  'f8bet',
  'shbet',
  'new88',
  'mb66',
  'qq88'
];

var AD_PATH_PATTERNS = [
  '/api/v1/public/normal-ads',
  '/api/v1/banners/public',
  '/storage/ads/',
  '/ads/ads-new/',
  '/quangcao/',
  '/preroll/',
  '/midroll/',
  '/tvc_mp4',
  '/vast',
  '/vpaid',
  'banner_ad',
  'adframe',
  'ima3.js',
  'popunder',
  'click_redirect'
];

function createAdBlocker() {
  var config = {
    enabled: true,
    blockDomains: true,
    blockEmbedAds: true,
    filterHlsAds: true
  };

  var stats = {
    totalBlocked: 0,
    blockedRequests: 0,
    blockedEmbedAds: 0,
    strippedHlsSegments: 0,
    recentLog: []
  };

  function recordBlock(layer, target, reason) {
    stats.totalBlocked += 1;
    if (layer === 'DOMAIN') stats.blockedRequests += 1;
    else if (layer === 'EMBED') stats.blockedEmbedAds += 1;
    else if (layer === 'HLS') stats.strippedHlsSegments += 1;

    stats.recentLog.unshift({
      time: new Date().toISOString().slice(11, 19),
      layer: layer,
      target: String(target || '').slice(0, 90),
      reason: reason || 'Blocked'
    });
    if (stats.recentLog.length > 40) {
      stats.recentLog.length = 40;
    }
  }

  function isAdUrl(rawUrl) {
    if (!config.enabled || !config.blockDomains || !rawUrl) return false;
    var lower = String(rawUrl).toLowerCase();
    for (var i = 0; i < AD_DOMAIN_PATTERNS.length; i++) {
      if (lower.indexOf(AD_DOMAIN_PATTERNS[i]) !== -1) {
        return 'Ad domain: ' + AD_DOMAIN_PATTERNS[i];
      }
    }
    for (var j = 0; j < AD_PATH_PATTERNS.length; j++) {
      if (lower.indexOf(AD_PATH_PATTERNS[j]) !== -1) {
        return 'Ad path: ' + AD_PATH_PATTERNS[j];
      }
    }
    return false;
  }

  function sanitizeEmbedData(embedData) {
    if (!config.enabled || !config.blockEmbedAds || !embedData) {
      return embedData;
    }
    var copy = JSON.parse(JSON.stringify(embedData));
    if (copy.ads) {
      var endpoint = copy.ads.endpoint || 'embed-ads';
      var types = Array.isArray(copy.ads.types) ? copy.ads.types : [];
      if (endpoint || types.length > 0) {
        recordBlock('EMBED', endpoint, 'Chặn ' + (types.length || 1) + ' loại QC player (' + types.slice(0, 3).join(', ') + ')');
      }
      copy.ads = null;
    }
    if (Array.isArray(copy.trackingPixels) && copy.trackingPixels.length > 0) {
      recordBlock('EMBED', 'trackingPixels', 'Chặn ' + copy.trackingPixels.length + ' tracking pixel');
      copy.trackingPixels = [];
    }
    return copy;
  }

  function getHostAndPrefix(segUrl) {
    try {
      var p = urlModule.parse(segUrl);
      var pathname = p.pathname || '';
      var parts = pathname.split('/').filter(Boolean);
      var prefix = parts.length >= 2 ? (parts[0] + '/' + parts[1]) : (parts[0] || '');
      return (p.hostname || '') + '/' + prefix;
    } catch (e) {
      return '';
    }
  }

  function filterM3u8Playlist(playlistText, baseUrl) {
    if (!config.enabled || !config.filterHlsAds || !playlistText) {
      return { text: playlistText, removedCount: 0 };
    }

    var lines = playlistText.split(/\r?\n/);
    // Master playlist check — don't strip variants, only filter ad URIs
    if (playlistText.indexOf('#EXT-X-STREAM-INF') !== -1) {
      return { text: playlistText, removedCount: 0 };
    }

    // Parse media playlist into header + discontinuity sections
    var headerLines = [];
    var sections = [];
    var currentSection = { hasDiscontinuity: false, segments: [], duration: 0, hostKeyCount: {} };
    var inHeader = true;
    var pendingTags = [];
    var inCueOut = false;
    var removedCount = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.indexOf('#EXT-X-CUE-OUT') === 0) {
        inCueOut = true;
        recordBlock('HLS', trimmed, 'SCTE-35 CUE-OUT ad block');
        continue;
      }
      if (trimmed.indexOf('#EXT-X-CUE-IN') === 0) {
        inCueOut = false;
        continue;
      }
      if (inCueOut) {
        if (trimmed.charAt(0) !== '#') removedCount += 1;
        continue;
      }

      if (trimmed === '#EXT-X-DISCONTINUITY') {
        inHeader = false;
        if (currentSection.segments.length > 0) {
          sections.push(currentSection);
        }
        currentSection = { hasDiscontinuity: true, segments: [], duration: 0, hostKeyCount: {} };
        pendingTags = [];
        continue;
      }

      if (trimmed === '#EXT-X-ENDLIST') {
        continue;
      }

      if (trimmed.charAt(0) === '#') {
        if (inHeader && trimmed.indexOf('#EXTINF') !== 0 && trimmed.indexOf('#EXT-X-KEY') !== 0 && trimmed.indexOf('#EXT-X-BYTERANGE') !== 0) {
          headerLines.push(trimmed);
        } else {
          inHeader = false;
          pendingTags.push(trimmed);
        }
      } else {
        inHeader = false;
        var absUrl = baseUrl ? urlModule.resolve(baseUrl, trimmed) : trimmed;
        var dur = 0;
        for (var k = 0; k < pendingTags.length; k++) {
          var m = pendingTags[k].match(/^#EXTINF:([0-9.]+)/);
          if (m) dur = parseFloat(m[1]) || 0;
        }
        var adReason = isAdUrl(absUrl);
        if (adReason) {
          removedCount += 1;
          recordBlock('HLS', absUrl, 'Chặn segment QC (' + adReason + ')');
          pendingTags = [];
          continue;
        }
        var hk = getHostAndPrefix(absUrl);
        currentSection.hostKeyCount[hk] = (currentSection.hostKeyCount[hk] || 0) + 1;
        currentSection.duration += dur;
        currentSection.segments.push({
          tags: pendingTags.slice(),
          url: trimmed,
          absUrl: absUrl,
          duration: dur,
          hostKey: hk
        });
        pendingTags = [];
      }
    }

    if (currentSection.segments.length > 0) {
      sections.push(currentSection);
    }

    // Determine dominant CDN hostKey across all sections
    var globalCounts = {};
    var dominantKey = '';
    var maxCount = 0;
    for (var s = 0; s < sections.length; s++) {
      var keys = Object.keys(sections[s].hostKeyCount);
      for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki];
        globalCounts[key] = (globalCounts[key] || 0) + sections[s].hostKeyCount[key];
        if (globalCounts[key] > maxCount) {
          maxCount = globalCounts[key];
          dominantKey = key;
        }
      }
    }

    // Rebuild clean playlist, dropping foreign-domain short discontinuity ad splices
    var outLines = headerLines.slice();
    var keptSections = 0;

    for (var idx = 0; idx < sections.length; idx++) {
      var sec = sections[idx];
      var secDominant = '';
      var secMax = 0;
      var secKeys = Object.keys(sec.hostKeyCount);
      for (var sk = 0; sk < secKeys.length; sk++) {
        if (sec.hostKeyCount[secKeys[sk]] > secMax) {
          secMax = sec.hostKeyCount[secKeys[sk]];
          secDominant = secKeys[sk];
        }
      }

      var isForeignSplice = (
        sections.length > 1 &&
        dominantKey &&
        secDominant &&
        secDominant !== dominantKey &&
        sec.duration > 0 &&
        sec.duration <= 65
      );

      if (isForeignSplice) {
        removedCount += sec.segments.length;
        recordBlock('HLS', secDominant, 'Cắt bỏ đoạn QC chèn giữa phim (' + sec.segments.length + ' segments, ' + Math.round(sec.duration) + 's)');
        continue;
      }

      if (keptSections > 0 && sec.hasDiscontinuity) {
        outLines.push('#EXT-X-DISCONTINUITY');
      }
      for (var segIdx = 0; segIdx < sec.segments.length; segIdx++) {
        var seg = sec.segments[segIdx];
        for (var ti = 0; ti < seg.tags.length; ti++) {
          outLines.push(seg.tags[ti]);
        }
        outLines.push(seg.url);
      }
      keptSections += 1;
    }

    if (playlistText.indexOf('#EXT-X-ENDLIST') !== -1) {
      outLines.push('#EXT-X-ENDLIST');
    }

    return {
      text: outLines.join('\n'),
      removedCount: removedCount
    };
  }

  return {
    getConfig: function () { return Object.assign({}, config); },
    updateConfig: function (patch) {
      if (!patch || typeof patch !== 'object') return config;
      if (typeof patch.enabled === 'boolean') config.enabled = patch.enabled;
      if (typeof patch.blockDomains === 'boolean') config.blockDomains = patch.blockDomains;
      if (typeof patch.blockEmbedAds === 'boolean') config.blockEmbedAds = patch.blockEmbedAds;
      if (typeof patch.filterHlsAds === 'boolean') config.filterHlsAds = patch.filterHlsAds;
      return Object.assign({}, config);
    },
    getStats: function () {
      return {
        config: Object.assign({}, config),
        totalBlocked: stats.totalBlocked,
        blockedRequests: stats.blockedRequests,
        blockedEmbedAds: stats.blockedEmbedAds,
        strippedHlsSegments: stats.strippedHlsSegments,
        recentLog: stats.recentLog.slice(0, 25)
      };
    },
    resetStats: function () {
      stats.totalBlocked = 0;
      stats.blockedRequests = 0;
      stats.blockedEmbedAds = 0;
      stats.strippedHlsSegments = 0;
      stats.recentLog = [];
    },
    isAdUrl: isAdUrl,
    recordBlock: recordBlock,
    sanitizeEmbedData: sanitizeEmbedData,
    filterM3u8Playlist: filterM3u8Playlist
  };
}

module.exports = { createAdBlocker: createAdBlocker };
