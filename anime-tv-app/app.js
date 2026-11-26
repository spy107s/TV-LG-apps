(function () {
  'use strict';

  var STORAGE_KEYS = {
    TOKEN: 'a47_access_token',
    REFRESH: 'a47_refresh_token',
    USER: 'a47_user',
    HISTORY: 'a47_watch_history',
    PROXY_URL: 'a47_proxy_url',
    ASPECT: 'a47_aspect_mode'
  };

  var ASPECT_MODES = [
    { id: 'contain', label: 'Vừa màn', cls: 'fit-contain', desc: 'Vừa màn hình (giữ đúng tỉ lệ gốc)' },
    { id: 'cover', label: 'Tràn viền', cls: 'fit-cover', desc: 'Tràn viền (tự động lấp đầy màn hình)' },
    { id: 'fill', label: 'Kéo đầy', cls: 'fit-fill', desc: 'Kéo đầy 16:9 toàn màn hình' },
    { id: 'zoom', label: 'Phóng to', cls: 'fit-zoom', desc: 'Phóng to cắt viền đen phim rạp 21:9' }
  ];

  var DEFAULT_AUTH = {
    login: '',
    password: ''
  };

  var state = {
    activeView: 'home',
    heroList: [],
    heroIndex: 0,
    currentAnime: null,
    currentGroups: [],
    activeGroupIdx: 0,
    currentEpisodes: [],
    currentEpisodeIdx: -1,
    currentStreams: [],
    activeStreamIdx: 0,
    subtitlesEnabled: true,
    aspectMode: 'contain',
    serviceBridge: null,
    topViewedPeriod: 'day',
    topViewedData: null,
    seasonTab: 'all',
    seasonCache: {},
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

  // ===== API & PROXY HELPERS =====
  function getProxyBase() {
    var saved = localStorage.getItem(STORAGE_KEYS.PROXY_URL);
    if (saved && saved.trim()) {
      return saved.trim().replace(/\/+$/, '').replace(':5050', ':5010');
    }
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      return '';
    }
    // Connects to local proxy on 127.0.0.1:5010 (runs natively on LG TV's Node.js or PC Simulator)
    return 'http://127.0.0.1:5010';
  }

  function buildApiUrl(path) {
    var proxy = getProxyBase();
    if (proxy !== null) {
      return proxy + '/proxy/api' + path;
    }
    return 'https://animevui.com/api' + path;
  }

  function buildStreamUrl(rawUrl) {
    if (!rawUrl) return '';
    var proxy = getProxyBase();
    if (proxy !== null && rawUrl.indexOf('http') === 0) {
      return proxy + '/proxy/stream?url=' + encodeURIComponent(rawUrl);
    }
    return rawUrl;
  }

  function sendClientLog(tag, detail) {
    try {
      var proxy = getProxyBase() || '';
      fetch(proxy + '/proxy/log', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: '[' + tag + '] ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))
      }).catch(function () {});
    } catch (e) {}
  }

  window.addEventListener('error', function (e) {
    sendClientLog('WINDOW-ERR', (e.message || 'Error') + ' at ' + (e.filename || '') + ':' + (e.lineno || 0));
  });
  window.addEventListener('unhandledrejection', function (e) {
    sendClientLog('PROMISE-ERR', String(e.reason && (e.reason.stack || e.reason.message || e.reason)));
  });

  function getAuthToken() {
    return localStorage.getItem(STORAGE_KEYS.TOKEN) || '';
  }

  function getStoredUser() {
    try {
      var raw = localStorage.getItem(STORAGE_KEYS.USER);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function apiFetch(path, options, isRetry) {
    options = options || {};
    var headers = options.headers || {};
    headers['Accept'] = 'application/json';
    var token = getAuthToken();
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    if (options.body && typeof options.body === 'object') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    options.headers = headers;

    return fetch(buildApiUrl(path), options).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try {
          data = txt ? JSON.parse(txt) : null;
        } catch (e) {
          data = { raw: txt };
        }
        if (res.status === 401 && !isRetry) {
          return tryRefreshToken().then(function (ok) {
            if (ok) return apiFetch(path, options, true);
            return tryAutoLogin().then(function (autoOk) {
              if (autoOk) return apiFetch(path, options, true);
              return { ok: false, status: 401, data: data };
            });
          });
        }
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function tryAutoLogin() {
    if (!DEFAULT_AUTH.login || !DEFAULT_AUTH.password) {
      return Promise.resolve(false);
    }
    return fetch(buildApiUrl('/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        login: DEFAULT_AUTH.login,
        password: DEFAULT_AUTH.password,
        remember: true
      })
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        if (!d) return false;
        var token = d.accessToken || d.access_token || (d.data && (d.data.accessToken || d.data.access_token));
        if (token) {
          localStorage.setItem(STORAGE_KEYS.TOKEN, token);
          var refresh = d.refreshToken || d.refresh_token || (d.data && (d.data.refreshToken || d.data.refresh_token));
          if (refresh) localStorage.setItem(STORAGE_KEYS.REFRESH, refresh);
          var user = d.user || (d.data && d.data.user) || { username: DEFAULT_AUTH.login };
          localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
          updateAuthUI();
          sendClientLog('AUTO-LOGIN-OK', user.username || DEFAULT_AUTH.login);
          return true;
        }
        return false;
      })
      .catch(function () { return false; });
  }

  function tryRefreshToken() {
    var refresh = localStorage.getItem(STORAGE_KEYS.REFRESH);
    if (!refresh) return Promise.resolve(false);
    return fetch(buildApiUrl('/auth/refresh-token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh })
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var token = data && (data.accessToken || data.access_token || (data.data && data.data.access_token));
        if (token) {
          localStorage.setItem(STORAGE_KEYS.TOKEN, token);
          var newRefresh = data.refreshToken || data.refresh_token || (data.data && data.data.refresh_token);
          if (newRefresh) localStorage.setItem(STORAGE_KEYS.REFRESH, newRefresh);
          return true;
        }
        return false;
      })
      .catch(function () { return false; });
  }

  // ===== UI UTILITIES =====
  function $(id) {
    return document.getElementById(id);
  }

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

  function getPosterUrl(item) {
    if (!item) return '';
    return item.image || item.posterUrl || item.poster || item.thumbnail || item.backdropImage || '';
  }

  function formatViews(v) {
    var num = Number(v);
    if (!isFinite(num) || num <= 0) return '';
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function createAnimeCard(item) {
    var btn = document.createElement('button');
    btn.className = 'anime-card focusable';
    var poster = getPosterUrl(item);

    var statusRaw = (item.status || '').toLowerCase();
    var topBadgeHtml = '';
    if (statusRaw === 'ongoing' || statusRaw.indexOf('đang') !== -1) {
      topBadgeHtml = '<span class="anime-card-status">ĐANG PHÁT</span>';
    } else if (statusRaw === 'completed' || statusRaw.indexOf('hoàn') !== -1) {
      topBadgeHtml = '<span class="anime-card-status completed">HOÀN THÀNH</span>';
    } else {
      var fallbackBadge = item.current_episode ? ('Tập ' + item.current_episode) : (item.type || 'ANIME');
      topBadgeHtml = '<span class="anime-card-badge">' + escapeHtml(fallbackBadge) + '</span>';
    }

    var epText = '';
    if (item.current_episode && Number(item.episodes) > 0) {
      epText = 'Ep ' + item.current_episode + '/' + item.episodes;
    } else if (item.current_episode) {
      epText = 'Ep ' + item.current_episode;
    }

    var bottomBadges = '';
    if (epText || item.lang_subs) {
      bottomBadges = '<div class="anime-card-bottom-badges">';
      if (epText) bottomBadges += '<span class="anime-card-ep-pill">▶ ' + escapeHtml(epText) + '</span>';
      if (item.lang_subs) bottomBadges += '<span class="anime-card-lang-pill">' + escapeHtml(item.lang_subs) + '</span>';
      bottomBadges += '</div>';
    }

    var metaParts = [];
    if (item.type) metaParts.push(String(item.type).toUpperCase());
    var viewsStr = formatViews(item.post_view || item.views);
    if (viewsStr) metaParts.push('👁 ' + viewsStr);
    if (!metaParts.length) {
      metaParts.push(item.status || (item.genres && item.genres.slice ? item.genres.slice(0, 2).join(' • ') : 'Vietsub'));
    }

    btn.innerHTML =
      '<div class="anime-card-poster-wrap">' +
        '<img class="anime-card-poster" loading="lazy" src="' + poster + '" alt="">' +
        topBadgeHtml +
        bottomBadges +
      '</div>' +
      '<div class="anime-card-body">' +
        '<div class="anime-card-title">' + escapeHtml(item.title || 'Không rõ tên') + '</div>' +
        '<div class="anime-card-meta">' + escapeHtml(metaParts.join(' • ')) + '</div>' +
      '</div>';

    btn.addEventListener('click', function () {
      openAnimeDetail(item);
    });
    return btn;
  }

  function createRankCard(item, idx) {
    var btn = document.createElement('button');
    btn.className = 'rank-item focusable';
    var rankNum = item.rank || (idx + 1);
    var rankLabel = rankNum < 10 ? ('0' + rankNum) : String(rankNum);
    var rankClass = rankNum <= 3 ? 'rank-badge rank-top' : 'rank-badge';
    var poster = getPosterUrl(item);

    var epLabel = item.current_episode ? String(item.current_episode) : '';
    var viewsLabel = formatViews(item.views || item.post_view);
    var typeLabel = item.type ? String(item.type).toUpperCase() : 'TV';

    var metaHtml = '';
    if (epLabel) metaHtml += '<span class="rank-pill ep">Tập ' + escapeHtml(epLabel) + '</span>';
    if (viewsLabel) metaHtml += '<span class="rank-pill">👁 ' + escapeHtml(viewsLabel) + '</span>';
    if (typeLabel) metaHtml += '<span class="rank-pill type">' + escapeHtml(typeLabel) + '</span>';

    btn.innerHTML =
      '<div class="' + rankClass + '">' + escapeHtml(rankLabel) + '</div>' +
      '<img class="rank-poster" loading="lazy" src="' + poster + '" alt="">' +
      '<div class="rank-info">' +
        '<div class="rank-title">' + escapeHtml(item.title || 'Không rõ tên') + '</div>' +
        '<div class="rank-meta">' + metaHtml + '</div>' +
      '</div>';

    btn.addEventListener('click', function () {
      openAnimeDetail(item);
    });
    return btn;
  }

  // ===== TOP VIEWED (XEM NHIỀU: HÔM NAY / TUẦN / THÁNG / NĂM) =====
  function updateSubTabActive(containerId, attrName, activeVal) {
    var container = $(containerId);
    if (!container) return;
    var btns = container.querySelectorAll('.sub-tab');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute(attrName) === activeVal);
    }
  }

  function renderTopViewedList(period) {
    state.topViewedPeriod = period || 'day';
    updateSubTabActive('top-viewed-tabs', 'data-period', state.topViewedPeriod);

    var listEl = $('list-top-viewed');
    var statusEl = $('top-viewed-status');
    if (!listEl) return;
    listEl.innerHTML = '';

    var bucket = state.topViewedData && state.topViewedData[state.topViewedPeriod];
    var items = Array.isArray(bucket) ? bucket : [];
    if (!items.length) {
      statusEl.textContent = 'Chưa có dữ liệu bảng xếp hạng cho mục này.';
      statusEl.classList.remove('hidden');
      return;
    }
    statusEl.classList.add('hidden');
    for (var i = 0; i < items.length; i++) {
      listEl.appendChild(createRankCard(items[i], i));
    }
  }

  function loadTopViewed(period, forceReload) {
    period = period || state.topViewedPeriod || 'day';
    state.topViewedPeriod = period;
    updateSubTabActive('top-viewed-tabs', 'data-period', period);

    if (state.topViewedData && !forceReload) {
      renderTopViewedList(period);
      return;
    }

    var statusEl = $('top-viewed-status');
    var listEl = $('list-top-viewed');
    if (listEl) listEl.innerHTML = '';
    if (statusEl) {
      statusEl.textContent = 'Đang tải bảng xếp hạng Xem nhiều nhất...';
      statusEl.classList.remove('hidden');
    }

    apiFetch('/sidebar/top-anime').then(function (res) {
      if (res.ok && res.data && typeof res.data === 'object') {
        state.topViewedData = res.data;
        renderTopViewedList(state.topViewedPeriod);
      } else if (statusEl) {
        statusEl.textContent = 'Không tải được danh sách Xem nhiều nhất.';
        statusEl.classList.remove('hidden');
      }
    }).catch(function () {
      if (statusEl) {
        statusEl.textContent = 'Lỗi kết nối khi tải danh sách Xem nhiều nhất.';
        statusEl.classList.remove('hidden');
      }
    });
  }

  // ===== SEASON (MÙA: TẤT CẢ / MÙA NÀY / MÙA TRƯỚC / CŨ HƠN) =====
  var SEASON_ENDPOINTS = {
    'all': '/home-page/latest-episode-posts',
    'current': '/home-page/latest-episode-posts/current-season',
    'last': '/home-page/latest-episode-posts/last-season',
    'older': '/home-page/latest-episode-posts/older'
  };

  function renderSeasonGrid(seasonKey, items) {
    var gridEl = $('grid-season');
    var statusEl = $('season-status');
    if (!gridEl) return;
    gridEl.innerHTML = '';
    if (!items || !items.length) {
      if (statusEl) {
        statusEl.textContent = 'Không có anime nào trong mục mùa này.';
        statusEl.classList.remove('hidden');
      }
      return;
    }
    if (statusEl) statusEl.classList.add('hidden');
    for (var i = 0; i < items.length; i++) {
      gridEl.appendChild(createAnimeCard(items[i]));
    }
  }

  function loadSeasonTab(seasonKey, forceReload) {
    seasonKey = seasonKey || state.seasonTab || 'all';
    state.seasonTab = seasonKey;
    updateSubTabActive('season-tabs', 'data-season', seasonKey);

    if (state.seasonCache[seasonKey] && !forceReload) {
      renderSeasonGrid(seasonKey, state.seasonCache[seasonKey]);
      return;
    }

    var gridEl = $('grid-season');
    var statusEl = $('season-status');
    if (gridEl) gridEl.innerHTML = '';
    if (statusEl) {
      statusEl.textContent = 'Đang tải danh sách Anime theo mùa...';
      statusEl.classList.remove('hidden');
    }

    var endpoint = SEASON_ENDPOINTS[seasonKey] || SEASON_ENDPOINTS.all;
    apiFetch(endpoint).then(function (res) {
      var list = Array.isArray(res.data) ? res.data : (res.data && Array.isArray(res.data.data) ? res.data.data : []);
      if (res.ok && list.length > 0) {
        state.seasonCache[seasonKey] = list;
        if (state.seasonTab === seasonKey) {
          renderSeasonGrid(seasonKey, list);
        }
      } else if (statusEl && state.seasonTab === seasonKey) {
        statusEl.textContent = 'Không tải được danh sách Anime theo mùa.';
        statusEl.classList.remove('hidden');
      }
    }).catch(function () {
      if (statusEl && state.seasonTab === seasonKey) {
        statusEl.textContent = 'Lỗi kết nối khi tải danh sách Anime theo mùa.';
        statusEl.classList.remove('hidden');
      }
    });
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

    if (viewName === 'top-viewed') {
      loadTopViewed(state.topViewedPeriod);
    } else if (viewName === 'season') {
      loadSeasonTab(state.seasonTab);
    } else if (viewName === 'history') {
      renderHistory();
    } else if (viewName === 'account') {
      updateAuthUI();
    } else if (viewName === 'settings') {
      $('proxy-url-input').value = localStorage.getItem(STORAGE_KEYS.PROXY_URL) || '';
    }
  }

  // ===== WEBOS NATIVE PROXY SERVICE BOOTSTRAP =====
  function waitForLocalProxy(onReady, maxTries) {
    maxTries = maxTries || 20;
    var tries = 0;
    var proxyBase = getProxyBase();

    function checkOnce() {
      tries += 1;
      fetch(proxyBase + '/', { cache: 'no-store' })
        .then(function (r) {
          if (r && r.ok) {
            onReady(true);
          } else if (tries < maxTries) {
            setTimeout(checkOnce, 350);
          } else {
            onReady(false);
          }
        })
        .catch(function () {
          if (tries < maxTries) {
            if ($('hero-desc') && tries === 3) {
              $('hero-desc').textContent = 'Đang khởi động máy chủ nội bộ trên TV...';
            }
            setTimeout(checkOnce, 350);
          } else {
            onReady(false);
          }
        });
    }

    checkOnce();
  }

  function ensureNativeService(onReady) {
    var startedPoll = false;
    function beginPoll() {
      if (startedPoll) return;
      startedPoll = true;
      waitForLocalProxy(function (ok) {
        if (typeof onReady === 'function') onReady(ok);
      }, 20);
    }

    if (typeof window.PalmServiceBridge !== 'function') {
      beginPoll();
      return;
    }

    // Start polling quickly in parallel with Luna service response (covers both cold & warm start)
    var fallbackTimer = setTimeout(beginPoll, 1200);
    try {
      var bridge = new window.PalmServiceBridge();
      state.serviceBridge = bridge;
      bridge.onservicecallback = function () {
        clearTimeout(fallbackTimer);
        beginPoll();
      };
      bridge.call('luna://com.giadinh.anime47tv.service/start', JSON.stringify({ subscribe: true }));
    } catch (e) {
      clearTimeout(fallbackTimer);
      beginPoll();
    }
  }

  // ===== PLAYER ASPECT / FRAME CONTROL =====
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
      localStorage.setItem(STORAGE_KEYS.ASPECT, mode.id);
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

  // ===== HOME DATA =====
  function loadHomeData(attempt) {
    attempt = attempt || 0;
    // 1. Hero Section
    apiFetch('/home-page/hero-section').then(function (res) {
      if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
        state.heroList = res.data;
        state.heroIndex = 0;
        renderHero();
      } else if (attempt < 3) {
        setTimeout(function () { loadHomeData(attempt + 1); }, 1500);
      }
    }).catch(function () {
      if (attempt < 3) {
        setTimeout(function () { loadHomeData(attempt + 1); }, 1500);
      } else {
        showToast('Không thể kết nối máy chủ Anime47. Kiểm tra lại mạng hoặc Proxy!');
      }
    });

    // 2. Trending Carousel
    apiFetch('/home-page/trending-carousel').then(function (res) {
      var list = Array.isArray(res.data) ? res.data : (res.data && res.data.data ? res.data.data : []);
      var container = $('row-trending');
      container.innerHTML = '';
      list.forEach(function (item) {
        container.appendChild(createAnimeCard(item));
      });
    }).catch(function () {});

    // 3. Latest Episodes
    apiFetch('/home-page/latest-episode-posts').then(function (res) {
      var list = Array.isArray(res.data) ? res.data : (res.data && res.data.data ? res.data.data : []);
      var container = $('grid-latest');
      container.innerHTML = '';
      list.forEach(function (item) {
        container.appendChild(createAnimeCard(item));
      });
    }).catch(function () {
      if (attempt >= 3) {
        showToast('Không thể kết nối máy chủ Anime47. Kiểm tra lại mạng hoặc Proxy!');
      }
    });
  }

  function renderHero() {
    if (!state.heroList.length) return;
    var item = state.heroList[state.heroIndex % state.heroList.length];
    var bg = item.backdropImage || item.poster || item.image || '';
    $('hero-backdrop').style.backgroundImage = bg ? 'url("' + bg + '")' : '';
    $('hero-title').textContent = item.title || 'Anime47';
    $('hero-desc').textContent = item.description || 'Xem anime Vietsub chất lượng cao miễn phí trên LG Smart TV.';
    $('hero-badge').textContent = item.season ? ('NỔI BẬT • SEASON ' + item.season) : 'NỔI BẬT';
  }

  // ===== SEARCH =====
  function performSearch(keyword) {
    keyword = (keyword || '').trim();
    if (!keyword) {
      $('search-status').textContent = 'Vui lòng nhập từ khóa cần tìm.';
      return;
    }
    $('search-input').value = keyword;
    $('search-status').textContent = 'Đang tìm "' + keyword + '"...';
    $('grid-search').innerHTML = '';

    apiFetch('/search/full/?keyword=' + encodeURIComponent(keyword)).then(function (res) {
      if (!res.ok) {
        $('search-status').textContent = 'Lỗi tìm kiếm (' + res.status + ').';
        return;
      }
      var results = (res.data && res.data.results) ? res.data.results : (Array.isArray(res.data) ? res.data : []);
      if (!results.length) {
        $('search-status').textContent = 'Không tìm thấy kết quả cho "' + keyword + '".';
        return;
      }
      $('search-status').textContent = 'Tìm thấy ' + results.length + ' kết quả cho "' + keyword + '"';
      var grid = $('grid-search');
      grid.innerHTML = '';
      results.forEach(function (item) {
        grid.appendChild(createAnimeCard(item));
      });
    }).catch(function () {
      $('search-status').textContent = 'Lỗi kết nối khi tìm kiếm.';
    });
  }

  // ===== WATCH HISTORY =====
  function getHistory() {
    try {
      var raw = localStorage.getItem(STORAGE_KEYS.HISTORY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveToHistory(anime, ep) {
    if (!anime || !anime.id) return;
    var list = getHistory().filter(function (x) { return String(x.id) !== String(anime.id); });
    list.unshift({
      id: anime.id,
      title: anime.title,
      image: getPosterUrl(anime),
      current_episode: ep ? (ep.number || ep.title || '') : (anime.current_episode || ''),
      lastEpisodeId: ep ? ep.id : null,
      description: anime.description || '',
      watchedAt: Date.now()
    });
    if (list.length > 30) list = list.slice(0, 30);
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(list));
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
      grid.appendChild(createAnimeCard(item));
    });
  }

  // ===== AUTHENTICATION =====
  function updateAuthUI() {
    var token = getAuthToken();
    var user = getStoredUser();
    var dot = $('auth-status-dot');
    var txt = $('auth-status-text');
    var navLabel = $('nav-account-label');

    if (token) {
      dot.classList.add('online');
      var name = (user && (user.name || user.username || user.email)) || 'Đã đăng nhập';
      txt.textContent = name;
      navLabel.textContent = 'Tài khoản';
      $('account-logged-out').classList.add('hidden');
      $('account-logged-in').classList.remove('hidden');
      $('user-display-name').textContent = name;
      $('user-display-email').textContent = (user && user.email) || 'Phiên đăng nhập đang hoạt động';
      $('user-avatar').textContent = name.charAt(0).toUpperCase();
    } else {
      dot.classList.remove('online');
      txt.textContent = 'Chưa đăng nhập';
      navLabel.textContent = 'Đăng nhập';
      $('account-logged-out').classList.remove('hidden');
      $('account-logged-in').classList.add('hidden');
    }
  }

  function doLogin() {
    var login = $('login-user').value.trim();
    var password = $('login-pass').value;
    var msgEl = $('login-message');

    if (!login || !password) {
      msgEl.textContent = 'Vui lòng nhập đầy đủ tài khoản và mật khẩu.';
      return;
    }
    msgEl.textContent = 'Đang đăng nhập vào Anime47...';

    apiFetch('/auth/login', {
      method: 'POST',
      body: { login: login, password: password, remember: true }
    }).then(function (res) {
      var d = res.data || {};
      var token = d.accessToken || d.access_token || (d.data && (d.data.accessToken || d.data.access_token));
      if (res.ok && token) {
        localStorage.setItem(STORAGE_KEYS.TOKEN, token);
        var refresh = d.refreshToken || d.refresh_token || (d.data && (d.data.refreshToken || d.data.refresh_token));
        if (refresh) localStorage.setItem(STORAGE_KEYS.REFRESH, refresh);
        var user = d.user || (d.data && d.data.user) || { username: login };
        localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
        msgEl.textContent = '';
        $('login-pass').value = '';
        updateAuthUI();
        showToast('Đăng nhập thành công! Bạn đã có thể xem mọi tập phim.');
        switchView('home');
      } else {
        msgEl.textContent = (d && d.message) || 'Đăng nhập thất bại. Vui lòng kiểm tra lại tài khoản/mật khẩu.';
      }
    }).catch(function (err) {
      msgEl.textContent = 'Lỗi kết nối: ' + err.message;
    });
  }

  function doLogout() {
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.REFRESH);
    localStorage.removeItem(STORAGE_KEYS.USER);
    updateAuthUI();
    showToast('Đã đăng xuất khỏi tài khoản Anime47.');
  }

  // ===== ANIME DETAIL & EPISODES =====
  function openAnimeDetail(item) {
    state.currentAnime = item;
    state.currentGroups = [];
    state.currentEpisodes = [];

    $('detail-poster').src = getPosterUrl(item);
    $('detail-title').textContent = item.title || 'Chi tiết phim';
    $('detail-desc').textContent = item.description || 'Đang tải thông tin chi tiết...';
    $('detail-auth-warning').classList.add('hidden');

    var tagsEl = $('detail-tags');
    tagsEl.innerHTML = '';
    var tags = [];
    if (item.status) tags.push(item.status);
    if (item.type) tags.push(item.type);
    if (item.current_episode) tags.push('Tập ' + item.current_episode);
    if (Array.isArray(item.genres)) tags = tags.concat(item.genres);
    tags.forEach(function (t) {
      var span = document.createElement('span');
      span.className = 'detail-tag';
      span.textContent = typeof t === 'string' ? t : (t.name || '');
      if (span.textContent) tagsEl.appendChild(span);
    });

    $('episode-group-tabs').innerHTML = '';
    $('episode-list').innerHTML = '<div class="status-message">Đang tải danh sách tập phim...</div>';
    $('detail-overlay').classList.remove('hidden');
    setFocus($('detail-close-btn'));

    // Fetch episodes
    apiFetch('/anime/' + item.id + '/episodes').then(function (res) {
      if (res.status === 401) {
        $('detail-auth-warning').classList.remove('hidden');
        $('episode-list').innerHTML = '<div class="status-message">Cần đăng nhập tài khoản Anime47 để xem danh sách tập phim.</div>';
        setFocus($('detail-goto-login-btn'));
        return;
      }
      if (!res.ok || !res.data) {
        $('episode-list').innerHTML = '<div class="status-message">Không tải được danh sách tập phim (Mã ' + res.status + ').</div>';
        return;
      }

      var groups = extractEpisodeGroups(res.data);
      state.currentGroups = groups;
      state.activeGroupIdx = 0;
      renderEpisodeGroups();
    }).catch(function () {
      $('episode-list').innerHTML = '<div class="status-message">Lỗi mạng khi tải danh sách tập phim.</div>';
    });
  }

  function extractEpisodeGroups(data) {
    var groups = [];
    if (Array.isArray(data.teams) && data.teams.length > 0) {
      data.teams.forEach(function (team, tIdx) {
        var teamPrefix = data.teams.length > 1 ? ((team.name || team.team_name || ('Nhóm ' + (tIdx + 1))) + ' - ') : '';
        if (Array.isArray(team.groups)) {
          team.groups.forEach(function (g, gIdx) {
            groups.push({
              name: teamPrefix + (g.name || ('Phần ' + (gIdx + 1))),
              episodes: Array.isArray(g.episodes) ? g.episodes : []
            });
          });
        }
      });
    } else if (Array.isArray(data.groups)) {
      data.groups.forEach(function (g, gIdx) {
        groups.push({
          name: g.name || ('Danh sách ' + (gIdx + 1)),
          episodes: Array.isArray(g.episodes) ? g.episodes : []
        });
      });
    } else if (Array.isArray(data.episodes)) {
      groups.push({ name: 'Tất cả tập', episodes: data.episodes });
    }
    return groups;
  }

  function renderEpisodeGroups() {
    var tabsEl = $('episode-group-tabs');
    var listEl = $('episode-list');
    tabsEl.innerHTML = '';
    listEl.innerHTML = '';

    if (!state.currentGroups.length) {
      listEl.innerHTML = '<div class="status-message">Chưa có tập phim nào được cập nhật.</div>';
      return;
    }

    if (state.currentGroups.length > 1) {
      state.currentGroups.forEach(function (grp, idx) {
        var tab = document.createElement('button');
        tab.className = 'group-tab focusable' + (idx === state.activeGroupIdx ? ' active' : '');
        tab.textContent = grp.name;
        tab.addEventListener('click', function () {
          state.activeGroupIdx = idx;
          renderEpisodeGroups();
        });
        tabsEl.appendChild(tab);
      });
    }

    var activeGroup = state.currentGroups[state.activeGroupIdx];
    state.currentEpisodes = activeGroup ? activeGroup.episodes : [];

    if (!state.currentEpisodes.length) {
      listEl.innerHTML = '<div class="status-message">Nhóm này chưa có tập phim nào.</div>';
      return;
    }

    state.currentEpisodes.forEach(function (ep, idx) {
      var btn = document.createElement('button');
      btn.className = 'ep-btn focusable';
      btn.textContent = ep.number ? ('Tập ' + ep.number) : (ep.title || ('Tập ' + (idx + 1)));
      btn.addEventListener('click', function () {
        playEpisodeByIndex(idx);
      });
      listEl.appendChild(btn);
    });

    var firstEpBtn = listEl.querySelector('.ep-btn');
    if (firstEpBtn) setFocus(firstEpBtn);
  }

  function closeAnimeDetail() {
    $('detail-overlay').classList.add('hidden');
    focusFirstInActiveScope();
  }

  // ===== VIDEO PLAYER =====
  function playEpisodeByIndex(epIdx) {
    if (epIdx < 0 || epIdx >= state.currentEpisodes.length) {
      showToast('Không còn tập phim kế tiếp.');
      return;
    }
    state.currentEpisodeIdx = epIdx;
    var ep = state.currentEpisodes[epIdx];
    saveToHistory(state.currentAnime, ep);

    $('player-overlay').classList.remove('hidden');
    $('player-anime-title').textContent = (state.currentAnime && state.currentAnime.title) || 'Anime47';
    $('player-ep-title').textContent = ep.number ? ('Tập ' + ep.number + (ep.title ? ' — ' + ep.title : '')) : (ep.title || 'Đang phát');
    $('player-servers').innerHTML = '';
    setPlayerLoading(true, 'Đang lấy link phát video...');
    showPlayerHud();
    setFocus($('btn-play-pause'));

    apiFetch('/anime/watch/episode/' + ep.id).then(function (res) {
      if (res.status === 401) {
        closePlayer();
        showToast('Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại!');
        switchView('account');
        return;
      }
      if (!res.ok || !res.data) {
        setPlayerLoading(false);
        showToast('Không lấy được nguồn phát cho tập này.');
        return;
      }

      var epData = res.data.episode || res.data.data || res.data;
      var streams = (epData && Array.isArray(epData.streams)) ? epData.streams : (Array.isArray(res.data.streams) ? res.data.streams : []);

      // Sort streams: prefer is_default=1, hardsub (burned-in Vietsub), or streams containing Vietnamese .vtt subtitles
      streams.sort(function (a, b) {
        return getStreamPriorityScore(a) - getStreamPriorityScore(b);
      });

      state.currentStreams = streams;
      state.activeStreamIdx = 0;
      renderServerButtons();

      if (!streams.length) {
        setPlayerLoading(false);
        showToast('Tập phim này hiện chưa có nguồn video.');
        return;
      }

      loadStream(0);
    }).catch(function () {
      setPlayerLoading(false);
      showToast('Lỗi mạng khi tải nguồn phát video.');
    });
  }

  function isVietnameseSub(sub) {
    if (!sub) return false;
    var lbl = (sub.label || '').toLowerCase();
    var file = (sub.file || '').toLowerCase();
    return (
      lbl.indexOf('việt') !== -1 ||
      lbl.indexOf('viet') !== -1 ||
      lbl === 'vi' ||
      file.indexOf('.vi.vtt') !== -1 ||
      file.indexOf('.vi_ai.vtt') !== -1 ||
      file.indexOf('_vi.vtt') !== -1
    );
  }

  function hasVietnameseSub(stream) {
    if (!stream || !Array.isArray(stream.subtitles)) return false;
    for (var i = 0; i < stream.subtitles.length; i++) {
      if (isVietnameseSub(stream.subtitles[i])) return true;
    }
    return false;
  }

  function getStreamPriorityScore(st) {
    if (!st) return 999;
    var isDirect = (st.player_type === 'hls' || st.player_type === 'jwplayer');
    var isHardsub = (st.code === 'hardsub');
    var hasVi = hasVietnameseSub(st);
    var isDef = Boolean(st.is_default);

    var score = isDirect ? 0 : 100;
    if (isHardsub || hasVi) {
      score -= 50; // Always prefer streams with Vietnamese subtitles (hardsub or .vi.vtt)
    }
    if (isDef) {
      score -= 20; // Prefer Anime47's default server
    }
    return score;
  }

  function renderServerButtons() {
    var container = $('player-servers');
    container.innerHTML = '';
    state.currentStreams.forEach(function (st, idx) {
      var btn = document.createElement('button');
      btn.className = 'server-btn focusable' + (idx === state.activeStreamIdx ? ' active' : '');
      var baseName = st.server_name || st.provider || ('Server ' + (idx + 1));
      var badge = st.code === 'hardsub' ? ' (Hardsub Việt)' : (hasVietnameseSub(st) ? ' (Vietsub)' : '');
      btn.textContent = baseName + badge;
      btn.addEventListener('click', function () {
        state.activeStreamIdx = idx;
        renderServerButtons();
        loadStream(idx);
      });
      container.appendChild(btn);
    });
  }

  function cleanupPlayerMedia() {
    var video = $('tv-video');
    var iframe = $('tv-iframe');

    if (state.hlsInstance) {
      state.hlsInstance.destroy();
      state.hlsInstance = null;
    }
    video.pause();
    video.removeAttribute('src');
    while (video.firstChild) video.removeChild(video.firstChild);
    video.load();

    iframe.src = 'about:blank';
    iframe.classList.add('hidden');
    video.classList.remove('hidden');
  }

  function loadStream(idx) {
    cleanupPlayerMedia();
    applyAspectMode(state.aspectMode, false);
    var stream = state.currentStreams[idx];
    if (!stream || !stream.url) {
      setPlayerLoading(false);
      showToast('Nguồn phát này không có đường dẫn hợp lệ.');
      return;
    }

    var video = $('tv-video');
    var iframe = $('tv-iframe');
    var pType = (stream.player_type || '').toLowerCase();
    var isHls = pType === 'hls' || pType === 'jwplayer' || stream.url.indexOf('.m3u8') !== -1;

    setPlayerLoading(true, 'Đang tải luồng ' + (stream.server_name || 'Video') + '...');

    if (pType === 'iframe' || (!isHls && stream.url.indexOf('.mp4') === -1)) {
      // Iframe fallback
      video.classList.add('hidden');
      iframe.classList.remove('hidden');
      iframe.src = stream.url;
      setPlayerLoading(false);
      return;
    }

    var finalUrl = buildStreamUrl(stream.url);
    sendClientLog('LOAD-STREAM', { server: stream.server_name, code: stream.code, type: pType, url: stream.url });

    // Attach only the primary Vietnamese (or default) subtitle track to avoid saturating HTTP connections
    if (Array.isArray(stream.subtitles) && stream.subtitles.length > 0) {
      var subs = stream.subtitles.slice().sort(function (a, b) {
        var aScore = (isVietnameseSub(a) ? 0 : 10) + (a.default ? 0 : 2);
        var bScore = (isVietnameseSub(b) ? 0 : 10) + (b.default ? 0 : 2);
        return aScore - bScore;
      });
      var bestSub = subs[0];
      if (bestSub && bestSub.file) {
        var track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = bestSub.label || 'Tiếng Việt';
        track.src = buildStreamUrl(bestSub.file);
        track.default = true;
        video.appendChild(track);
      }
    }

    if (isHls && window.Hls && window.Hls.isSupported()) {
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
      hls.loadSource(finalUrl);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, function (ev, data) {
        sendClientLog('HLS-MANIFEST-OK', { levels: data && data.levels ? data.levels.length : 0 });
        setPlayerLoading(false);
        video.play().catch(function (err) {
          sendClientLog('VIDEO-PLAY-ERR', err && err.message ? err.message : String(err));
        });
        applySubtitleVisibility();
        startPlaybackWatchdog();
      });
      hls.on(window.Hls.Events.ERROR, function (event, data) {
        sendClientLog('HLS-ERR', {
          type: data && data.type,
          details: data && data.details,
          fatal: Boolean(data && data.fatal),
          reason: data && data.reason,
          errMsg: data && data.error && data.error.message
        });
        if (data && data.details === 'bufferStalledError' && !video.paused) {
          // If stalled right before a buffered range gap, nudge across the gap
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
            sendClientLog('HLS-RECOVER', 'Attempting recoverMediaError()');
            hls.recoverMediaError();
          } else if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            sendClientLog('HLS-RECOVER', 'Attempting startLoad()');
            hls.startLoad();
          } else {
            setPlayerLoading(false);
            showToast('Lỗi luồng HLS (' + (data.details || 'fatal') + '). Hãy thử Server khác!');
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl') || stream.url.indexOf('.mp4') !== -1) {
      video.src = finalUrl;
      video.addEventListener('loadedmetadata', function onMeta() {
        video.removeEventListener('loadedmetadata', onMeta);
        setPlayerLoading(false);
        video.play().catch(function () {});
        applySubtitleVisibility();
        startPlaybackWatchdog();
      });
    } else {
      setPlayerLoading(false);
      showToast('Trình duyệt TV không hỗ trợ định dạng này. Hãy thử Server khác!');
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

      // If audio clock advanced > 0.5s while 0 video frames were decoded, recover video decoder
      if (!video.paused && !state.isSeeking && timeDelta > 0.5 && curFrames >= 0 && frameDelta <= 0 && state.hlsInstance) {
        sendClientLog('WATCHDOG-RECOVER', 'Audio advancing with 0 decoded video frames — calling recoverMediaError()');
        state.hlsInstance.recoverMediaError();
      }
    }, 3000);
  }

  function applySubtitleVisibility() {
    var video = $('tv-video');
    var activeStream = state.currentStreams[state.activeStreamIdx];
    if (activeStream && activeStream.code === 'hardsub') {
      $('btn-sub-toggle').textContent = '💬 Phụ đề: Hardsub Việt';
      return;
    }
    if (!video.textTracks || video.textTracks.length === 0) {
      $('btn-sub-toggle').textContent = '💬 Phụ đề: Không có';
      return;
    }
    var trackLabel = video.textTracks[0].label || 'Bật';
    for (var i = 0; i < video.textTracks.length; i++) {
      video.textTracks[i].mode = (state.subtitlesEnabled && i === 0) ? 'showing' : 'disabled';
    }
    $('btn-sub-toggle').textContent = state.subtitlesEnabled ? ('💬 Phụ đề: ' + trackLabel) : '💬 Phụ đề: Tắt';
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
    if (video.paused) {
      video.play().catch(function () {});
    } else {
      video.pause();
    }
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
      var fStart = f.start;
      var fEnd = fStart + f.duration;
      if (targetSec >= fStart && targetSec <= fEnd) {
        if (direction > 0 && (targetSec - fStart > f.duration * 0.45) && i + 1 < frags.length) {
          return frags[i + 1].start + 0.05;
        }
        return fStart + 0.05;
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
    clearTimeout(state.frameWatchTimer);
    state.frameWatchTimer = setTimeout(finishSeek, 1200);

    video.currentTime = target;
  }

  function seekBy(seconds) {
    var video = $('tv-video');
    if (!isFinite(video.duration)) return;

    if (state.pendingSeekTarget === null) {
      if (!state.isSeeking) {
        state.wasPlayingBeforeSeek = !video.paused;
      }
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
      if (target !== null) {
        executeSafeSeek(target, delta >= 0 ? 1 : -1);
      }
    }, 220);
  }

  function closePlayer() {
    clearInterval(state.telemetryTimer);
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
      var el = all[i];
      if (el.offsetParent !== null && !el.disabled) {
        visible.push(el);
      }
    }
    return visible;
  }

  function setFocus(el) {
    if (!el) return;
    if (state.focusedEl && state.focusedEl !== el) {
      state.focusedEl.classList.remove('tv-focused');
    }
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
      var x = r.left + r.width / 2;
      var y = r.top + r.height / 2;
      var dx = x - cx;
      var dy = y - cy;

      var isValid = false;
      var primaryDist = 0;
      var secondaryDist = 0;

      if (direction === 'right' && dx > 10) {
        isValid = true; primaryDist = dx; secondaryDist = Math.abs(dy);
      } else if (direction === 'left' && dx < -10) {
        isValid = true; primaryDist = -dx; secondaryDist = Math.abs(dy);
      } else if (direction === 'down' && dy > 10) {
        isValid = true; primaryDist = dy; secondaryDist = Math.abs(dx);
      } else if (direction === 'up' && dy < -10) {
        isValid = true; primaryDist = -dy; secondaryDist = Math.abs(dx);
      }

      if (isValid) {
        var score = primaryDist + secondaryDist * 2.5;
        if (score < bestScore) {
          bestScore = score;
          bestEl = cand;
        }
      }
    }

    if (bestEl) {
      setFocus(bestEl);
    }
  }

  function handleBackKey() {
    if (!$('player-overlay').classList.contains('hidden')) {
      closePlayer();
      return;
    }
    if (!$('detail-overlay').classList.contains('hidden')) {
      closeAnimeDetail();
      return;
    }
    if (state.activeView !== 'home') {
      switchView('home');
      focusFirstInActiveScope();
      return;
    }
    // On webOS TV, Back at root can minimize/exit app
    if (window.webOS && window.webOS.platformBack) {
      window.webOS.platformBack();
    }
  }

  function setupKeyboardAndRemote() {
    document.addEventListener('keydown', function (e) {
      var key = e.key;
      var code = e.keyCode || e.which;
      var isInput = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
      var inPlayer = !$('player-overlay').classList.contains('hidden');

      // LG TV Back Key = 461, Escape = 27
      if (code === 461 || key === 'Escape' || (key === 'Backspace' && !isInput)) {
        e.preventDefault();
        handleBackKey();
        return;
      }

      // LG TV Media Remote Keys when in player
      if (inPlayer) {
        if (code === 415) { // Play
          e.preventDefault(); $('tv-video').play(); showPlayerHud(); return;
        }
        if (code === 19) { // Pause
          e.preventDefault(); $('tv-video').pause(); showPlayerHud(); return;
        }
        if (code === 417) { // Fast Forward
          e.preventDefault(); seekBy(10); return;
        }
        if (code === 412) { // Rewind
          e.preventDefault(); seekBy(-10); return;
        }
        if (code === 413) { // Stop
          e.preventDefault(); closePlayer(); return;
        }

        // Normalize D-Pad keys for LG webOS remote (handles both e.key and e.keyCode)
        var isRight = (key === 'ArrowRight' || key === 'Right' || code === 39);
        var isLeft = (key === 'ArrowLeft' || key === 'Left' || code === 37);
        var isUp = (key === 'ArrowUp' || key === 'Up' || code === 38);
        var isDown = (key === 'ArrowDown' || key === 'Down' || code === 40);
        var isEnter = (key === 'Enter' || key === ' ' || code === 13);

        // If HUD is hidden: Down/Up immediately show the control bar & focus Play/Pause; Left/Right seek directly
        var hudHidden = $('player-hud').classList.contains('hud-hidden');
        if (hudHidden) {
          if (isDown || isUp) {
            e.preventDefault();
            showPlayerHud(true);
            setFocus($('btn-play-pause'));
            return;
          }
          if (isRight) { e.preventDefault(); seekBy(10); return; }
          if (isLeft) { e.preventDefault(); seekBy(-10); return; }
          if (isEnter) { e.preventDefault(); togglePlayPause(); return; }
        } else {
          showPlayerHud(false);
        }
      }

      // Inside text input: let Left/Right move cursor, Enter submit search/login
      if (isInput) {
        if (key === 'ArrowDown') {
          e.preventDefault();
          moveFocusDirection('down');
        } else if (key === 'ArrowUp') {
          e.preventDefault();
          moveFocusDirection('up');
        } else if (key === 'Enter') {
          if (document.activeElement.id === 'search-input') {
            performSearch($('search-input').value);
          } else if (document.activeElement.id === 'login-pass') {
            doLogin();
          }
        }
        return;
      }

      // Standard TV D-Pad navigation
      if (key === 'ArrowUp' || key === 'Up' || code === 38) { e.preventDefault(); moveFocusDirection('up'); }
      else if (key === 'ArrowDown' || key === 'Down' || code === 40) { e.preventDefault(); moveFocusDirection('down'); }
      else if (key === 'ArrowLeft' || key === 'Left' || code === 37) { e.preventDefault(); moveFocusDirection('left'); }
      else if (key === 'ArrowRight' || key === 'Right' || code === 39) { e.preventDefault(); moveFocusDirection('right'); }
      else if (key === ' ' && inPlayer) { e.preventDefault(); togglePlayPause(); }
    });
  }

  // ===== EVENT BINDINGS =====
  function bindEvents() {
    // Sidebar nav
    var navItems = document.querySelectorAll('.nav-item');
    for (var i = 0; i < navItems.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          switchView(btn.getAttribute('data-nav'));
        });
      })(navItems[i]);
    }

    // Hero buttons
    $('hero-play-btn').addEventListener('click', function () {
      if (state.heroList.length) {
        openAnimeDetail(state.heroList[state.heroIndex % state.heroList.length]);
      }
    });
    $('hero-next-btn').addEventListener('click', function () {
      if (state.heroList.length) {
        state.heroIndex = (state.heroIndex + 1) % state.heroList.length;
        renderHero();
      }
    });

    // Top Viewed sub-tabs (Hôm nay / Tuần / Tháng / Năm)
    var topTabBtns = document.querySelectorAll('#top-viewed-tabs .sub-tab');
    for (var tv = 0; tv < topTabBtns.length; tv++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          loadTopViewed(btn.getAttribute('data-period'));
        });
      })(topTabBtns[tv]);
    }

    // Season sub-tabs (Tất cả / Mùa này / Mùa trước / Cũ hơn)
    var seasonTabBtns = document.querySelectorAll('#season-tabs .sub-tab');
    for (var st = 0; st < seasonTabBtns.length; st++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          loadSeasonTab(btn.getAttribute('data-season'));
        });
      })(seasonTabBtns[st]);
    }

    // Search
    $('search-submit-btn').addEventListener('click', function () {
      performSearch($('search-input').value);
    });
    $('search-clear-btn').addEventListener('click', function () {
      $('search-input').value = '';
      $('grid-search').innerHTML = '';
      $('search-status').textContent = '';
      setFocus($('search-input'));
    });
    var tagBtns = document.querySelectorAll('.tag-btn');
    for (var t = 0; t < tagBtns.length; t++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          performSearch(btn.getAttribute('data-tag'));
        });
      })(tagBtns[t]);
    }

    // History
    $('clear-history-btn').addEventListener('click', function () {
      localStorage.removeItem(STORAGE_KEYS.HISTORY);
      renderHistory();
      showToast('Đã xóa lịch sử xem.');
    });

    // Account
    $('login-submit-btn').addEventListener('click', doLogin);
    $('logout-btn').addEventListener('click', doLogout);

    // Settings
    $('save-settings-btn').addEventListener('click', function () {
      var val = $('proxy-url-input').value.trim();
      if (val) localStorage.setItem(STORAGE_KEYS.PROXY_URL, val);
      else localStorage.removeItem(STORAGE_KEYS.PROXY_URL);
      $('settings-message').textContent = 'Đã lưu cài đặt! Đang tải lại dữ liệu...';
      loadHomeData();
    });
    $('reset-settings-btn').addEventListener('click', function () {
      localStorage.removeItem(STORAGE_KEYS.PROXY_URL);
      $('proxy-url-input').value = '';
      $('settings-message').textContent = 'Đã khôi phục mặc định.';
      loadHomeData();
    });

    // Detail overlay
    $('detail-close-btn').addEventListener('click', closeAnimeDetail);
    $('detail-goto-login-btn').addEventListener('click', function () {
      closeAnimeDetail();
      switchView('account');
      setFocus($('login-user'));
    });

    // Player controls
    $('player-back-btn').addEventListener('click', closePlayer);
    $('btn-play-pause').addEventListener('click', togglePlayPause);
    $('btn-rewind').addEventListener('click', function () { seekBy(-10); });
    $('btn-forward').addEventListener('click', function () { seekBy(10); });
    $('btn-prev-ep').addEventListener('click', function () { playEpisodeByIndex(state.currentEpisodeIdx - 1); });
    $('btn-next-ep').addEventListener('click', function () { playEpisodeByIndex(state.currentEpisodeIdx + 1); });
    $('btn-sub-toggle').addEventListener('click', function () {
      state.subtitlesEnabled = !state.subtitlesEnabled;
      applySubtitleVisibility();
    });
    if ($('btn-aspect')) {
      $('btn-aspect').addEventListener('click', cycleAspectMode);
    }

    $('player-overlay').addEventListener('mousemove', function () {
      showPlayerHud(false);
    });
    $('player-overlay').addEventListener('mousedown', function (e) {
      var hud = $('player-hud');
      var wasHidden = hud.classList.contains('hud-hidden');
      showPlayerHud(true);
      // If user clicked directly on video area while HUD was already visible, toggle play/pause
      if (!wasHidden && (e.target === $('tv-video') || e.target === hud)) {
        togglePlayPause();
      }
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

    // Video element events
    var video = $('tv-video');
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
    video.addEventListener('timeupdate', function () {
      if (state.pendingSeekTarget !== null) return;
      $('time-current').textContent = formatTime(video.currentTime);
      $('time-duration').textContent = formatTime(video.duration);
      var pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
      $('progress-fill').style.width = pct + '%';
    });
    video.addEventListener('play', function () {
      $('btn-play-pause').textContent = '⏸ Tạm dừng';
    });
    video.addEventListener('pause', function () {
      $('btn-play-pause').textContent = '▶ Tiếp tục';
      showPlayerHud();
    });
    video.addEventListener('waiting', function () {
      setPlayerLoading(true, 'Đang tải bộ đệm...');
    });
    video.addEventListener('playing', function () {
      setPlayerLoading(false);
    });
    video.addEventListener('ended', function () {
      if (state.currentEpisodeIdx + 1 < state.currentEpisodes.length) {
        showToast('Tự động chuyển sang tập tiếp theo...');
        playEpisodeByIndex(state.currentEpisodeIdx + 1);
      } else {
        showPlayerHud();
      }
    });
    video.addEventListener('error', function () {
      var err = video.error;
      sendClientLog('VIDEO-ELEM-ERR', {
        code: err ? err.code : null,
        message: err ? err.message : null
      });
    });
  }

  // ===== INIT =====
  function init() {
    try {
      var savedAspect = localStorage.getItem(STORAGE_KEYS.ASPECT);
      if (savedAspect) state.aspectMode = savedAspect;
    } catch (e) {}
    applyAspectMode(state.aspectMode, false);

    if ($('login-user') && !$('login-user').value) $('login-user').value = DEFAULT_AUTH.login;
    if ($('login-pass') && !$('login-pass').value) $('login-pass').value = DEFAULT_AUTH.password;
    updateAuthUI();
    bindEvents();
    setupKeyboardAndRemote();

    ensureNativeService(function () {
      sendClientLog('APP-INIT', {
        app: 'Anime47 TV',
        ua: navigator.userAgent,
        hlsSupported: Boolean(window.Hls && window.Hls.isSupported()),
        nativeBridge: typeof window.PalmServiceBridge === 'function',
        mseH264: Boolean(window.MediaSource && window.MediaSource.isTypeSupported && window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"'))
      });
      if (!getAuthToken() && DEFAULT_AUTH.login && DEFAULT_AUTH.password) {
        tryAutoLogin().then(function (ok) {
          if (ok) showToast('Đã tự động đăng nhập tài khoản: ' + DEFAULT_AUTH.login);
        });
      }
      loadHomeData(0);
    });
    setTimeout(focusFirstInActiveScope, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
