(function () {
  'use strict';

  var HISTORY_KEY = 'rophim_tv_history';
  var ASPECT_KEY = 'rophim_tv_aspect';
  var ASPECT_MODES = [
    { id: 'contain', label: 'Vừa màn', cls: 'fit-contain', desc: 'Vừa màn hình (giữ đúng tỉ lệ gốc)' },
    { id: 'cover', label: 'Tràn viền', cls: 'fit-cover', desc: 'Tràn viền (tự động lấp đầy màn hình)' },
    { id: 'fill', label: 'Kéo đầy', cls: 'fit-fill', desc: 'Kéo đầy 16:9 toàn màn hình' },
    { id: 'zoom', label: 'Phóng to', cls: 'fit-zoom', desc: 'Phóng to cắt viền đen phim rạp 21:9' }
  ];

  var state = {
    activeView: 'home',
    heroList: [],
    heroIndex: 0,
    currentMovie: null,
    currentGroups: [],
    activeGroupIdx: 0,
    currentEpisodes: [],
    currentEpisodeIdx: -1,
    currentSources: [],
    activeSourceIdx: 0,
    aspectMode: 'contain',
    adblockConfig: {
      enabled: true,
      blockDomains: true,
      blockEmbedAds: true,
      filterHlsAds: true
    },
    hlsInstance: null,
    hudTimer: null,
    toastTimer: null,
    seekTimer: null,
    frameWatchTimer: null,
    telemetryTimer: null,
    lastTelemetryTime: 0,
    lastTelemetryFrames: 0,
    isSeeking: false,
    pendingSeekTarget: null,
    pendingSeekDelta: 0,
    wasPlayingBeforeSeek: true,
    focusedEl: null
  };

  function getApiBase() {
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      return '';
    }
    return 'http://127.0.0.1:5020';
  }

  function $(id) {
    return document.getElementById(id);
  }

  function sendClientLog(tag, detail) {
    try {
      fetch(getApiBase() + '/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: '[' + tag + '] ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
      }).catch(function () {});
    } catch (e) {}
  }

  window.addEventListener('error', function (e) {
    sendClientLog('WINDOW-ERR', (e.message || 'Error') + ' at ' + (e.filename || '') + ':' + (e.lineno || 0));
  });

  function showToast(msg, duration) {
    var toast = $('toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      toast.classList.add('hidden');
    }, duration || 3000);
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return '00:00';
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    var mm = m < 10 ? '0' + m : '' + m;
    var ss = s < 10 ? '0' + s : '' + s;
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function createMovieCard(item) {
    var btn = document.createElement('button');
    btn.className = 'movie-card focusable';
    var badge = item.episode_current ? item.episode_current : (item.quality || 'HD');
    var lang = item.language || 'Vietsub';
    var meta = item.origin_name || (item.publish_year ? ('Năm ' + item.publish_year) : item.quality);

    btn.innerHTML =
      '<div class="movie-card-poster-wrap">' +
        '<img class="movie-card-poster" loading="lazy" src="' + escapeHtml(item.poster || item.backdrop || '') + '" alt="">' +
        '<span class="movie-card-badge">' + escapeHtml(badge) + '</span>' +
        '<span class="movie-card-lang">' + escapeHtml(lang) + '</span>' +
      '</div>' +
      '<div class="movie-card-body">' +
        '<div class="movie-card-title">' + escapeHtml(item.name || 'Không rõ tên') + '</div>' +
        '<div class="movie-card-meta">' + escapeHtml(meta || '') + '</div>' +
      '</div>';

    btn.addEventListener('click', function () {
      openMovieDetail(item);
    });
    return btn;
  }

  // ===== VIEW NAVIGATION =====
  function switchView(viewName) {
    state.activeView = viewName;
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) {
      views[i].classList.remove('active');
    }
    var target = $('view-' + viewName);
    if (target) target.classList.add('active');

    var navItems = document.querySelectorAll('.nav-item');
    for (var j = 0; j < navItems.length; j++) {
      navItems[j].classList.toggle('active', navItems[j].getAttribute('data-nav') === viewName);
    }

    if (viewName === 'history') renderHistory();
    else if (viewName === 'adblock') refreshAdblockStats();
  }

  // ===== WEBOS NATIVE PROXY SERVICE BOOTSTRAP =====
  function ensureNativeService(onReady) {
    var finished = false;
    function done() {
      if (finished) return;
      finished = true;
      if (typeof onReady === 'function') onReady();
    }

    if (typeof window.PalmServiceBridge !== 'function') {
      done();
      return;
    }

    var timer = setTimeout(done, 1800);
    try {
      var bridge = new window.PalmServiceBridge();
      state.serviceBridge = bridge;
      bridge.onservicecallback = function () {
        clearTimeout(timer);
        done();
      };
      bridge.call('luna://com.giadinh.rophimtv.service/start', JSON.stringify({ subscribe: true }));
    } catch (e) {
      clearTimeout(timer);
      done();
    }
  }

  // ===== HOME DATA =====
  function loadHomeData(attempt) {
    attempt = attempt || 0;
    fetch(getApiBase() + '/api/home')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && Array.isArray(data.hero) && data.hero.length > 0) {
          state.heroList = data.hero;
          state.heroIndex = 0;
          renderHero();
        }
        var container = $('home-collections');
        container.innerHTML = '';
        var cols = (data && Array.isArray(data.collections)) ? data.collections : [];
        cols.forEach(function (col) {
          var block = document.createElement('div');
          block.className = 'section-block';
          var title = document.createElement('h2');
          title.className = 'section-title';
          title.textContent = '🎬 ' + col.title;
          var row = document.createElement('div');
          row.className = 'card-row';
          (col.movies || []).forEach(function (m) {
            row.appendChild(createMovieCard(m));
          });
          block.appendChild(title);
          block.appendChild(row);
          container.appendChild(block);
        });
        refreshAdblockStats();
      })
      .catch(function (err) {
        if (attempt < 4) {
          $('hero-desc').textContent = 'Đang khởi động máy chủ lọc quảng cáo trên TV (' + (attempt + 1) + '/4)...';
          setTimeout(function () { loadHomeData(attempt + 1); }, 1200);
          return;
        }
        sendClientLog('HOME-ERR', err.message || String(err));
        showToast('Không thể kết nối RoPhim Server (cổng 5020).');
      });
  }

  function renderHero() {
    if (!state.heroList.length) return;
    var item = state.heroList[state.heroIndex % state.heroList.length];
    var bg = item.backdrop || item.poster || '';
    $('hero-backdrop').style.backgroundImage = bg ? 'url("' + bg + '")' : '';
    $('hero-title').textContent = item.name || 'RoPhim TV';
    var metaParts = [];
    if (item.origin_name) metaParts.push(item.origin_name);
    if (item.publish_year) metaParts.push(item.publish_year);
    if (item.quality) metaParts.push(item.quality);
    if (item.language) metaParts.push(item.language);
    $('hero-meta').textContent = metaParts.join(' • ');
    $('hero-desc').textContent = item.description || 'Xem phim online chất lượng cao không quảng cáo trên LG Smart TV.';
  }

  // ===== SEARCH =====
  function performSearch(keyword) {
    keyword = (keyword || '').trim();
    if (!keyword) {
      $('search-status').textContent = 'Vui lòng nhập từ khóa cần tìm.';
      return;
    }
    $('search-input').value = keyword;
    $('search-status').textContent = 'Đang tìm "' + keyword + '" trên RoPhim...';
    $('grid-search').innerHTML = '';

    fetch(getApiBase() + '/api/search?q=' + encodeURIComponent(keyword))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var list = (data && Array.isArray(data.movies)) ? data.movies : [];
        if (!list.length) {
          $('search-status').textContent = 'Không tìm thấy phim nào cho "' + keyword + '".';
          return;
        }
        $('search-status').textContent = 'Tìm thấy ' + list.length + ' phim cho "' + keyword + '"';
        var grid = $('grid-search');
        grid.innerHTML = '';
        list.forEach(function (m) {
          grid.appendChild(createMovieCard(m));
        });
      })
      .catch(function () {
        $('search-status').textContent = 'Lỗi kết nối khi tìm kiếm.';
      });
  }

  // ===== WATCH HISTORY =====
  function getHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveToHistory(movie, ep) {
    if (!movie || !movie.slug) return;
    var list = getHistory().filter(function (x) { return x.slug !== movie.slug; });
    list.unshift({
      id: movie.id,
      slug: movie.slug,
      name: movie.name,
      origin_name: movie.origin_name || '',
      description: movie.description || '',
      poster: movie.poster || movie.backdrop || '',
      backdrop: movie.backdrop || movie.poster || '',
      quality: movie.quality || 'HD',
      publish_year: movie.publish_year || '',
      episode_current: ep ? ep.name : (movie.episode_current || ''),
      language: ep ? ep.server : (movie.language || 'Vietsub'),
      watchedAt: Date.now()
    });
    if (list.length > 30) list = list.slice(0, 30);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  }

  function renderHistory() {
    var list = getHistory();
    var grid = $('grid-history');
    var empty = $('history-empty');
    grid.innerHTML = '';
    if (!list.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.forEach(function (item) {
      grid.appendChild(createMovieCard(item));
    });
  }

  // ===== ADBLOCKER DASHBOARD =====
  function refreshAdblockStats() {
    fetch(getApiBase() + '/api/adblock/stats')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data) return;
        applyAdblockStatsUI(data);
      })
      .catch(function () {});
  }

  function applyAdblockStatsUI(data) {
    if (data.config) state.adblockConfig = data.config;
    var total = data.totalBlocked || 0;
    $('sidebar-adblock-count').textContent = String(total);
    $('stat-total').textContent = String(total);
    $('stat-embed').textContent = String(data.blockedEmbedAds || 0);
    $('stat-domain').textContent = String(data.blockedRequests || 0);
    $('stat-hls').textContent = String(data.strippedHlsSegments || 0);

    var isOn = Boolean(state.adblockConfig.enabled);
    $('adblock-status-dot').classList.toggle('online', isOn);
    $('adblock-status-text').textContent = isOn ? ('AdBlock: Bật (' + total + ')') : 'AdBlock: Đang tắt';
    $('hud-adblock-pill').textContent = isOn ? ('🛡️ Đã chặn ' + total + ' QC') : '⚠️ AdBlock Tắt';

    updateTogglePill('pill-enabled', state.adblockConfig.enabled);
    updateTogglePill('pill-blockEmbedAds', state.adblockConfig.blockEmbedAds);
    updateTogglePill('pill-blockDomains', state.adblockConfig.blockDomains);
    updateTogglePill('pill-filterHlsAds', state.adblockConfig.filterHlsAds);

    var logEl = $('adblock-log-list');
    var logs = Array.isArray(data.recentLog) ? data.recentLog : [];
    if (!logs.length) {
      logEl.innerHTML = '<div class="log-empty">Chưa có quảng cáo nào bị phát hiện.</div>';
      return;
    }
    logEl.innerHTML = '';
    logs.forEach(function (entry) {
      var row = document.createElement('div');
      row.className = 'log-item';
      row.innerHTML =
        '<span class="log-time">' + escapeHtml(entry.time) + '</span>' +
        '<span class="log-tag">' + escapeHtml(entry.layer) + '</span>' +
        '<span class="log-text">' + escapeHtml(entry.reason + ' — ' + entry.target) + '</span>';
      logEl.appendChild(row);
    });
  }

  function updateTogglePill(id, val) {
    var el = $(id);
    if (!el) return;
    el.classList.toggle('on', Boolean(val));
    el.textContent = val ? 'ĐANG BẬT' : 'ĐANG TẮT';
  }

  function toggleAdblockKey(key) {
    var patch = {};
    patch[key] = !state.adblockConfig[key];
    fetch(getApiBase() + '/api/adblock/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        applyAdblockStatsUI(data);
        showToast('Đã cập nhật cài đặt Chặn Quảng Cáo!');
      })
      .catch(function () {});
  }

  // ===== MOVIE DETAIL & EPISODES =====
  function openMovieDetail(movie) {
    state.currentMovie = movie;
    state.currentGroups = [];
    state.currentEpisodes = [];

    $('detail-poster').src = movie.poster || movie.backdrop || '';
    $('detail-title').textContent = movie.name || 'Chi tiết phim';
    $('detail-origin').textContent = movie.origin_name || '';
    $('detail-desc').textContent = movie.description || 'Đang tải danh sách tập phim...';

    var tagsEl = $('detail-tags');
    tagsEl.innerHTML = '';
    var tags = [];
    if (movie.quality) tags.push(movie.quality);
    if (movie.language) tags.push(movie.language);
    if (movie.publish_year) tags.push('Năm ' + movie.publish_year);
    if (movie.episode_current) tags.push(movie.episode_current);
    tags.forEach(function (t) {
      var span = document.createElement('span');
      span.className = 'detail-tag';
      span.textContent = String(t);
      tagsEl.appendChild(span);
    });

    $('episode-group-tabs').innerHTML = '';
    $('episode-list').innerHTML = '<div class="status-message">Đang tải danh sách tập từ RoPhim...</div>';
    $('detail-overlay').classList.remove('hidden');
    setFocus($('detail-close-btn'));

    fetch(getApiBase() + '/api/movie?slug=' + encodeURIComponent(movie.slug))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var groups = (data && Array.isArray(data.groups)) ? data.groups : [];
        state.currentGroups = groups;
        state.activeGroupIdx = 0;
        renderEpisodeGroups();
        refreshAdblockStats();
      })
      .catch(function () {
        $('episode-list').innerHTML = '<div class="status-message">Lỗi mạng khi tải danh sách tập phim.</div>';
      });
  }

  function renderEpisodeGroups() {
    var tabsEl = $('episode-group-tabs');
    var listEl = $('episode-list');
    tabsEl.innerHTML = '';
    listEl.innerHTML = '';

    if (!state.currentGroups.length) {
      listEl.innerHTML = '<div class="status-message">Phim này chưa có tập phát sóng.</div>';
      return;
    }

    state.currentGroups.forEach(function (grp, idx) {
      var tab = document.createElement('button');
      tab.className = 'group-tab focusable' + (idx === state.activeGroupIdx ? ' active' : '');
      tab.textContent = grp.name + ' (' + grp.episodes.length + ')';
      tab.addEventListener('click', function () {
        state.activeGroupIdx = idx;
        renderEpisodeGroups();
      });
      tabsEl.appendChild(tab);
    });

    var activeGroup = state.currentGroups[state.activeGroupIdx];
    state.currentEpisodes = activeGroup ? activeGroup.episodes : [];

    state.currentEpisodes.forEach(function (ep, idx) {
      var btn = document.createElement('button');
      btn.className = 'ep-btn focusable';
      btn.textContent = ep.name || ('Tập ' + (idx + 1));
      btn.addEventListener('click', function () {
        playEpisodeByIndex(idx);
      });
      listEl.appendChild(btn);
    });

    var firstEp = listEl.querySelector('.ep-btn');
    if (firstEp) setFocus(firstEp);
  }

  function closeMovieDetail() {
    $('detail-overlay').classList.add('hidden');
    focusFirstInActiveScope();
  }

  // ===== VIDEO PLAYER =====
  function getAspectModeObj(modeId) {
    for (var i = 0; i < ASPECT_MODES.length; i++) {
      if (ASPECT_MODES[i].id === modeId) return ASPECT_MODES[i];
    }
    return ASPECT_MODES[0];
  }

  function applyAspectMode(modeId, announce) {
    var mode = getAspectModeObj(modeId);
    state.aspectMode = mode.id;
    try {
      localStorage.setItem(ASPECT_KEY, mode.id);
    } catch (e) {}

    var video = $('tv-video');
    if (video) {
      for (var i = 0; i < ASPECT_MODES.length; i++) {
        video.classList.remove(ASPECT_MODES[i].cls);
      }
      video.classList.add(mode.cls);
    }

    var btn = $('btn-aspect');
    if (btn) {
      btn.textContent = '🖥️ Khung hình: ' + mode.label;
    }

    if (announce) {
      showToast('🖥️ Khung hình: ' + mode.desc, 2200);
      showPlayerHud(false);
    }
  }

  function cycleAspectMode() {
    var curIdx = 0;
    for (var i = 0; i < ASPECT_MODES.length; i++) {
      if (ASPECT_MODES[i].id === state.aspectMode) {
        curIdx = i;
        break;
      }
    }
    var nextMode = ASPECT_MODES[(curIdx + 1) % ASPECT_MODES.length];
    applyAspectMode(nextMode.id, true);
  }

  function playEpisodeByIndex(epIdx) {
    if (epIdx < 0 || epIdx >= state.currentEpisodes.length) {
      showToast('Không còn tập phim kế tiếp.');
      return;
    }
    state.currentEpisodeIdx = epIdx;
    var ep = state.currentEpisodes[epIdx];
    saveToHistory(state.currentMovie, ep);

    applyAspectMode(state.aspectMode, false);
    $('player-overlay').classList.remove('hidden');
    $('player-movie-title').textContent = (state.currentMovie && state.currentMovie.name) || 'RoPhim TV';
    $('player-ep-title').textContent = ep.name + ' • ' + ep.server;
    $('player-servers').innerHTML = '';
    setPlayerLoading(true, '🛡️ Đang lọc quảng cáo & lấy luồng sạch...');
    showPlayerHud(true);
    setFocus($('btn-play-pause'));

    fetch(getApiBase() + '/api/resolve?embed=' + encodeURIComponent(ep.link))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.adblockStats) applyAdblockStatsUI(data.adblockStats);

        var sources = (data && Array.isArray(data.sources)) ? data.sources : [];
        state.currentSources = sources;
        state.activeSourceIdx = 0;
        renderServerButtons();

        if (sources.length > 0) {
          loadHlsSource(0);
        } else if (data && data.embedUrl) {
          loadIframeFallback(data.embedUrl);
        } else {
          setPlayerLoading(false);
          showToast('Không tìm thấy nguồn phát cho tập này.');
        }
      })
      .catch(function (err) {
        sendClientLog('RESOLVE-ERR', err.message || String(err));
        setPlayerLoading(false);
        showToast('Lỗi khi giải mã luồng phim.');
      });
  }

  function renderServerButtons() {
    var container = $('player-servers');
    container.innerHTML = '';
    state.currentSources.forEach(function (src, idx) {
      var btn = document.createElement('button');
      btn.className = 'server-btn focusable' + (idx === state.activeSourceIdx ? ' active' : '');
      btn.textContent = src.label || ('Server ' + (idx + 1));
      btn.addEventListener('click', function () {
        state.activeSourceIdx = idx;
        renderServerButtons();
        loadHlsSource(idx);
      });
      container.appendChild(btn);
    });
  }

  function cleanupPlayerMedia() {
    clearInterval(state.telemetryTimer);
    var video = $('tv-video');
    var iframe = $('tv-iframe');
    if (state.hlsInstance) {
      state.hlsInstance.destroy();
      state.hlsInstance = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();

    iframe.src = 'about:blank';
    iframe.classList.add('hidden');
    video.classList.remove('hidden');
  }

  function loadIframeFallback(embedUrl) {
    cleanupPlayerMedia();
    $('tv-video').classList.add('hidden');
    var iframe = $('tv-iframe');
    iframe.classList.remove('hidden');
    iframe.src = embedUrl;
    setPlayerLoading(false);
  }

  function loadHlsSource(idx) {
    cleanupPlayerMedia();
    var src = state.currentSources[idx];
    if (!src || !src.streamUrl) {
      setPlayerLoading(false);
      return;
    }

    var video = $('tv-video');
    setPlayerLoading(true, 'Đang tải ' + (src.label || 'HLS') + '...');
    sendClientLog('LOAD-HLS', { label: src.label, tier: src.tier });

    if (window.Hls && window.Hls.isSupported()) {
      var hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 10,
        maxMaxBufferLength: 15,
        maxBufferSize: 15 * 1000 * 1000,
        backBufferLength: 6,
        maxBufferHole: 0.5,
        nudgeOffset: 0.15,
        nudgeMaxRetry: 10
      });
      state.hlsInstance = hls;
      hls.loadSource(src.streamUrl);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, function (ev, data) {
        sendClientLog('HLS-MANIFEST-OK', { levels: data && data.levels ? data.levels.length : 0 });
        setPlayerLoading(false);
        video.play().catch(function (err) {
          sendClientLog('VIDEO-PLAY-ERR', err && err.message ? err.message : String(err));
        });
        startPlaybackWatchdog();
        refreshAdblockStats();
      });
      hls.on(window.Hls.Events.ERROR, function (event, data) {
        sendClientLog('HLS-ERR', {
          type: data && data.type,
          details: data && data.details,
          fatal: Boolean(data && data.fatal),
          errMsg: data && data.error && data.error.message
        });
        if (data && data.details === 'bufferStalledError' && !video.paused) {
          for (var b = 0; b < video.buffered.length; b++) {
            var bStart = video.buffered.start(b);
            if (bStart > video.currentTime && bStart - video.currentTime < 1.5) {
              video.currentTime = bStart + 0.05;
              break;
            }
          }
        }
        if (data && data.fatal) {
          if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else if (data.details === 'manifestLoadError' || data.details === 'manifestLoadTimeOut' || data.details === 'manifestParsingError') {
            if (idx + 1 < state.currentSources.length) {
              state.activeSourceIdx = idx + 1;
              renderServerButtons();
              loadHlsSource(idx + 1);
            } else {
              setPlayerLoading(false);
              showToast('Không tải được nguồn phim này. Hãy thử tập khác!');
            }
          } else if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else if (idx + 1 < state.currentSources.length) {
            state.activeSourceIdx = idx + 1;
            renderServerButtons();
            loadHlsSource(idx + 1);
          } else {
            setPlayerLoading(false);
            showToast('Lỗi nguồn phát HLS. Hãy thử lại!');
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src.streamUrl;
      video.addEventListener('loadedmetadata', function onMeta() {
        video.removeEventListener('loadedmetadata', onMeta);
        setPlayerLoading(false);
        video.play().catch(function () {});
        startPlaybackWatchdog();
      });
    }
  }

  function startPlaybackWatchdog() {
    clearInterval(state.telemetryTimer);
    var video = $('tv-video');
    state.lastTelemetryTime = video.currentTime || 0;
    state.lastTelemetryFrames = video.webkitDecodedFrameCount || 0;

    state.telemetryTimer = setInterval(function () {
      if ($('player-overlay').classList.contains('hidden')) {
        clearInterval(state.telemetryTimer);
        return;
      }
      var curTime = video.currentTime || 0;
      var curFrames = typeof video.webkitDecodedFrameCount === 'number' ? video.webkitDecodedFrameCount : -1;
      var bufRanges = [];
      for (var i = 0; i < video.buffered.length; i++) {
        bufRanges.push(video.buffered.start(i).toFixed(1) + '-' + video.buffered.end(i).toFixed(1));
      }
      var timeDelta = curTime - state.lastTelemetryTime;
      var frameDelta = curFrames >= 0 ? (curFrames - state.lastTelemetryFrames) : 1;
      state.lastTelemetryTime = curTime;
      state.lastTelemetryFrames = curFrames;

      sendClientLog('PLAYER-STAT', {
        t: Number(curTime.toFixed(2)),
        paused: video.paused,
        ready: video.readyState,
        decoded: curFrames,
        frameDelta: frameDelta,
        buf: bufRanges.join(',')
      });

      if (!video.paused && !state.isSeeking && timeDelta > 0.5 && curFrames >= 0 && frameDelta <= 0 && state.hlsInstance) {
        sendClientLog('WATCHDOG-RECOVER', 'Recovering video decoder');
        state.hlsInstance.recoverMediaError();
      }
    }, 3000);
  }

  function setPlayerLoading(show, text) {
    var el = $('player-loading');
    if (text) $('player-loading-text').textContent = text;
    if (show) el.classList.remove('hidden');
    else el.classList.add('hidden');
  }

  function showPlayerHud(ensureFocus) {
    var hud = $('player-hud');
    var wasHidden = hud.classList.contains('hud-hidden');
    hud.classList.remove('hud-hidden');

    if (ensureFocus || wasHidden) {
      var active = document.activeElement;
      if (!active || !hud.contains(active)) {
        setFocus($('btn-play-pause'));
      }
    }

    clearTimeout(state.hudTimer);
    state.hudTimer = setTimeout(function () {
      var video = $('tv-video');
      if (!video.paused && !state.isSeeking && state.pendingSeekTarget === null && !$('player-overlay').classList.contains('hidden')) {
        hud.classList.add('hud-hidden');
      }
    }, 5500);
  }

  function togglePlayPause() {
    var video = $('tv-video');
    if (video.paused) video.play().catch(function () {});
    else video.pause();
    showPlayerHud(true);
  }

  function snapToFragmentKeyframe(targetSec, direction) {
    var hls = state.hlsInstance;
    if (!hls || !hls.levels || !hls.levels.length) return targetSec;
    var levelIdx = hls.currentLevel >= 0 ? hls.currentLevel : 0;
    var details = hls.levels[levelIdx] && hls.levels[levelIdx].details;
    var frags = details && details.fragments;
    if (!Array.isArray(frags) || !frags.length) return targetSec;

    for (var i = 0; i < frags.length; i++) {
      var f = frags[i];
      if (targetSec >= f.start && targetSec <= f.start + f.duration) {
        if (direction > 0 && (targetSec - f.start > f.duration * 0.45) && i + 1 < frags.length) {
          return frags[i + 1].start + 0.05;
        }
        return f.start + 0.05;
      }
    }
    return targetSec;
  }

  function executeSafeSeek(rawTargetSec, direction) {
    var video = $('tv-video');
    if (!isFinite(video.duration)) return;

    var clamped = Math.max(0, Math.min(video.duration - 1, rawTargetSec));
    var target = snapToFragmentKeyframe(clamped, direction);
    var shouldResume = state.wasPlayingBeforeSeek;

    state.isSeeking = true;
    clearTimeout(state.frameWatchTimer);
    setPlayerLoading(true, 'Đang tua đến ' + formatTime(target) + '...');

    var done = false;
    var finishSeek = function () {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finishSeek);
      video.removeEventListener('canplay', finishSeek);
      state.isSeeking = false;
      setPlayerLoading(false);
      if (shouldResume && video.paused) {
        video.play().catch(function () {});
      }
      state.lastTelemetryTime = video.currentTime || 0;
      state.lastTelemetryFrames = video.webkitDecodedFrameCount || 0;
    };

    video.addEventListener('seeked', finishSeek);
    video.addEventListener('canplay', finishSeek);
    state.frameWatchTimer = setTimeout(finishSeek, 1200);
    video.currentTime = target;
  }

  function seekBy(seconds) {
    var video = $('tv-video');
    if (!isFinite(video.duration)) return;

    if (state.pendingSeekTarget === null) {
      if (!state.isSeeking) state.wasPlayingBeforeSeek = !video.paused;
      state.pendingSeekTarget = video.currentTime;
      state.pendingSeekDelta = 0;
    }

    state.pendingSeekDelta += seconds;
    state.pendingSeekTarget = Math.max(0, Math.min(video.duration - 1, state.pendingSeekTarget + seconds));

    $('time-current').textContent = formatTime(state.pendingSeekTarget);
    var pct = video.duration ? (state.pendingSeekTarget / video.duration) * 100 : 0;
    $('progress-fill').style.width = pct + '%';

    var sign = state.pendingSeekDelta >= 0 ? '⏩ +' : '⏪ ';
    showToast(sign + state.pendingSeekDelta + 's (' + formatTime(state.pendingSeekTarget) + ')', 1400);
    showPlayerHud(true);

    clearTimeout(state.seekTimer);
    state.seekTimer = setTimeout(function () {
      var target = state.pendingSeekTarget;
      var delta = state.pendingSeekDelta;
      state.pendingSeekTarget = null;
      state.pendingSeekDelta = 0;
      if (target !== null) executeSafeSeek(target, delta >= 0 ? 1 : -1);
    }, 220);
  }

  function closePlayer() {
    clearTimeout(state.seekTimer);
    clearTimeout(state.frameWatchTimer);
    state.isSeeking = false;
    state.pendingSeekTarget = null;
    state.pendingSeekDelta = 0;
    cleanupPlayerMedia();
    clearTimeout(state.hudTimer);
    $('player-overlay').classList.add('hidden');
    focusFirstInActiveScope();
  }

  // ===== SPATIAL TV D-PAD NAVIGATION =====
  function getActiveScopeElement() {
    if (!$('player-overlay').classList.contains('hidden')) return $('player-hud');
    if (!$('detail-overlay').classList.contains('hidden')) return $('detail-overlay');
    return $('app');
  }

  function getVisibleFocusables() {
    var scope = getActiveScopeElement();
    var all = scope.querySelectorAll('.focusable');
    var visible = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].offsetParent !== null && !all[i].disabled) visible.push(all[i]);
    }
    return visible;
  }

  function setFocus(el) {
    if (!el) return;
    if (state.focusedEl && state.focusedEl !== el) state.focusedEl.classList.remove('tv-focused');
    state.focusedEl = el;
    el.classList.add('tv-focused');
    try {
      el.focus({ preventScroll: false });
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    } catch (e) {
      el.focus();
    }
  }

  function focusFirstInActiveScope() {
    var list = getVisibleFocusables();
    if (list.length > 0) setFocus(list[0]);
  }

  function moveFocusDirection(direction) {
    var list = getVisibleFocusables();
    if (!list.length) return;

    var current = document.activeElement;
    if (!current || !current.classList.contains('focusable') || list.indexOf(current) === -1) {
      setFocus(list[0]);
      return;
    }

    var rect = current.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var bestEl = null;
    var bestScore = Infinity;

    for (var i = 0; i < list.length; i++) {
      var cand = list[i];
      if (cand === current) continue;
      var r = cand.getBoundingClientRect();
      var dx = (r.left + r.width / 2) - cx;
      var dy = (r.top + r.height / 2) - cy;

      var isValid = false;
      var primaryDist = 0;
      var secondaryDist = 0;

      if (direction === 'right' && dx > 10) { isValid = true; primaryDist = dx; secondaryDist = Math.abs(dy); }
      else if (direction === 'left' && dx < -10) { isValid = true; primaryDist = -dx; secondaryDist = Math.abs(dy); }
      else if (direction === 'down' && dy > 10) { isValid = true; primaryDist = dy; secondaryDist = Math.abs(dx); }
      else if (direction === 'up' && dy < -10) { isValid = true; primaryDist = -dy; secondaryDist = Math.abs(dx); }

      if (isValid) {
        var score = primaryDist + secondaryDist * 2.5;
        if (score < bestScore) { bestScore = score; bestEl = cand; }
      }
    }
    if (bestEl) setFocus(bestEl);
  }

  function handleBackKey() {
    if (!$('player-overlay').classList.contains('hidden')) { closePlayer(); return; }
    if (!$('detail-overlay').classList.contains('hidden')) { closeMovieDetail(); return; }
    if (state.activeView !== 'home') { switchView('home'); focusFirstInActiveScope(); return; }
    if (window.webOS && window.webOS.platformBack) window.webOS.platformBack();
  }

  function setupKeyboardAndRemote() {
    document.addEventListener('keydown', function (e) {
      var key = e.key;
      var code = e.keyCode || e.which;
      var isInput = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
      var inPlayer = !$('player-overlay').classList.contains('hidden');

      if (code === 461 || key === 'Escape' || (key === 'Backspace' && !isInput)) {
        e.preventDefault();
        handleBackKey();
        return;
      }

      if (inPlayer) {
        if (code === 415) { e.preventDefault(); $('tv-video').play(); showPlayerHud(true); return; }
        if (code === 19) { e.preventDefault(); $('tv-video').pause(); showPlayerHud(true); return; }
        if (code === 417) { e.preventDefault(); seekBy(10); return; }
        if (code === 412) { e.preventDefault(); seekBy(-10); return; }
        if (code === 413) { e.preventDefault(); closePlayer(); return; }

        var hudHidden = $('player-hud').classList.contains('hud-hidden');
        if (hudHidden) {
          if (key === 'ArrowRight') { e.preventDefault(); seekBy(10); return; }
          if (key === 'ArrowLeft') { e.preventDefault(); seekBy(-10); return; }
          if (key === 'Enter' || key === ' ') { e.preventDefault(); togglePlayPause(); return; }
          if (key === 'ArrowUp' || key === 'ArrowDown') { e.preventDefault(); showPlayerHud(true); setFocus($('btn-play-pause')); return; }
        } else {
          showPlayerHud(false);
        }
      }

      if (isInput) {
        if (key === 'ArrowDown') { e.preventDefault(); moveFocusDirection('down'); }
        else if (key === 'ArrowUp') { e.preventDefault(); moveFocusDirection('up'); }
        else if (key === 'Enter' && document.activeElement.id === 'search-input') {
          performSearch($('search-input').value);
        }
        return;
      }

      if (key === 'ArrowUp') { e.preventDefault(); moveFocusDirection('up'); }
      else if (key === 'ArrowDown') { e.preventDefault(); moveFocusDirection('down'); }
      else if (key === 'ArrowLeft') { e.preventDefault(); moveFocusDirection('left'); }
      else if (key === 'ArrowRight') { e.preventDefault(); moveFocusDirection('right'); }
      else if (key === ' ' && inPlayer) { e.preventDefault(); togglePlayPause(); }
    });
  }

  function bindEvents() {
    var navItems = document.querySelectorAll('.nav-item');
    for (var i = 0; i < navItems.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          switchView(btn.getAttribute('data-nav'));
        });
      })(navItems[i]);
    }

    $('hero-play-btn').addEventListener('click', function () {
      if (state.heroList.length) openMovieDetail(state.heroList[state.heroIndex % state.heroList.length]);
    });
    $('hero-next-btn').addEventListener('click', function () {
      if (state.heroList.length) {
        state.heroIndex = (state.heroIndex + 1) % state.heroList.length;
        renderHero();
      }
    });

    $('search-submit-btn').addEventListener('click', function () { performSearch($('search-input').value); });
    $('search-clear-btn').addEventListener('click', function () {
      $('search-input').value = '';
      $('grid-search').innerHTML = '';
      $('search-status').textContent = '';
      setFocus($('search-input'));
    });

    var tagBtns = document.querySelectorAll('.tag-btn');
    for (var t = 0; t < tagBtns.length; t++) {
      (function (btn) {
        btn.addEventListener('click', function () { performSearch(btn.getAttribute('data-tag')); });
      })(tagBtns[t]);
    }

    $('clear-history-btn').addEventListener('click', function () {
      localStorage.removeItem(HISTORY_KEY);
      renderHistory();
      showToast('Đã xóa lịch sử xem.');
    });

    var toggleBtns = document.querySelectorAll('.toggle-row');
    for (var k = 0; k < toggleBtns.length; k++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          toggleAdblockKey(btn.getAttribute('data-key'));
        });
      })(toggleBtns[k]);
    }

    $('adblock-reset-btn').addEventListener('click', function () {
      fetch(getApiBase() + '/api/adblock/reset', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          applyAdblockStatsUI(data);
          showToast('Đã đặt lại thống kê Chặn Quảng Cáo.');
        })
        .catch(function () {});
    });

    $('detail-close-btn').addEventListener('click', closeMovieDetail);

    $('player-back-btn').addEventListener('click', closePlayer);
    $('btn-play-pause').addEventListener('click', togglePlayPause);
    $('btn-rewind').addEventListener('click', function () { seekBy(-10); });
    $('btn-forward').addEventListener('click', function () { seekBy(10); });
    $('btn-prev-ep').addEventListener('click', function () { playEpisodeByIndex(state.currentEpisodeIdx - 1); });
    $('btn-next-ep').addEventListener('click', function () { playEpisodeByIndex(state.currentEpisodeIdx + 1); });
    if ($('btn-aspect')) {
      $('btn-aspect').addEventListener('click', cycleAspectMode);
    }

    $('player-overlay').addEventListener('mousemove', function () { showPlayerHud(false); });
    $('player-overlay').addEventListener('mousedown', function (e) {
      var hud = $('player-hud');
      var wasHidden = hud.classList.contains('hud-hidden');
      showPlayerHud(true);
      if (!wasHidden && (e.target === $('tv-video') || e.target === hud)) togglePlayPause();
    });

    $('progress-track').addEventListener('click', function (e) {
      var video = $('tv-video');
      if (!isFinite(video.duration)) return;
      var rect = this.getBoundingClientRect();
      var ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      var target = ratio * video.duration;
      state.wasPlayingBeforeSeek = !video.paused;
      executeSafeSeek(target, target >= video.currentTime ? 1 : -1);
      showPlayerHud(true);
    });

    var video = $('tv-video');
    video.addEventListener('timeupdate', function () {
      if (state.pendingSeekTarget !== null) return;
      $('time-current').textContent = formatTime(video.currentTime);
      $('time-duration').textContent = formatTime(video.duration);
      var pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
      $('progress-fill').style.width = pct + '%';
    });
    video.addEventListener('loadedmetadata', function () {
      applyAspectMode(state.aspectMode, false);
      sendClientLog('VIDEO-META', {
        vw: video.videoWidth || 0,
        vh: video.videoHeight || 0,
        w: video.clientWidth || 0,
        h: video.clientHeight || 0,
        aspect: state.aspectMode
      });
    });
    video.addEventListener('play', function () { $('btn-play-pause').textContent = '⏸ Tạm dừng'; });
    video.addEventListener('pause', function () { $('btn-play-pause').textContent = '▶ Tiếp tục'; showPlayerHud(false); });
    video.addEventListener('waiting', function () { setPlayerLoading(true, 'Đang tải bộ đệm...'); });
    video.addEventListener('playing', function () { setPlayerLoading(false); });
    video.addEventListener('ended', function () {
      if (state.currentEpisodeIdx + 1 < state.currentEpisodes.length) {
        showToast('Tự động chuyển sang tập tiếp theo...');
        playEpisodeByIndex(state.currentEpisodeIdx + 1);
      } else {
        showPlayerHud(true);
      }
    });
  }

  function init() {
    try {
      var savedAspect = localStorage.getItem(ASPECT_KEY);
      if (savedAspect) state.aspectMode = savedAspect;
    } catch (e) {}
    applyAspectMode(state.aspectMode, false);

    bindEvents();
    setupKeyboardAndRemote();
    ensureNativeService(function () {
      sendClientLog('APP-INIT', {
        app: 'RoPhim TV',
        ua: navigator.userAgent,
        hlsSupported: Boolean(window.Hls && window.Hls.isSupported()),
        nativeBridge: typeof window.PalmServiceBridge === 'function'
      });
      loadHomeData(0);
    });
    setTimeout(focusFirstInActiveScope, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
