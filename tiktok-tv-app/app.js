(function () {
  'use strict';

  var STORAGE_FAVS = 'tiktok_tv_favorites_v1';

  var SVG_MUTE_ON = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
  var SVG_MUTE_OFF = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
  var SVG_AUTONEXT = '<path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>';
  var SVG_REPEAT = '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>';

  var state = {
    categories: [],
    activeCatId: 120,
    activeCatLabel: '🔥 Đề xuất',
    videos: [],
    currentIdx: -1,
    isFetching: false,
    autoNext: true,
    muted: false,
    theaterMode: false,
    commentsOpen: false,
    toastTimer: null,
    playBadgeTimer: null,
    heartTimer: null,
    wheelLock: false,
    serviceBridge: null,
    focusedEl: null
  };

  function getApiBase() {
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      return '';
    }
    return 'http://127.0.0.1:5070';
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

  function showToast(msg, ms) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      t.classList.add('hidden');
    }, ms || 2200);
  }

  function formatCount(n) {
    var num = Number(n || 0);
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(num);
  }

  function formatSec(sec) {
    if (!isFinite(sec) || sec < 0) return '00:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return (m < 10 ? '0' + m : '' + m) + ':' + (s < 10 ? '0' + s : '' + s);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ===== FAVORITES (LOCAL STORAGE) =====
  function readFavs() {
    try {
      var raw = localStorage.getItem(STORAGE_FAVS);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function writeFavs(list) {
    try { localStorage.setItem(STORAGE_FAVS, JSON.stringify(list)); } catch (e) {}
  }

  function isFav(id) {
    if (!id) return false;
    var list = readFavs();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return true;
    }
    return false;
  }

  function triggerHeartBurst() {
    var el = $('heart-burst');
    if (!el) return;
    el.classList.remove('hidden');
    // Force animation restart cleanly
    el.style.animation = 'none';
    el.offsetHeight;
    el.style.animation = '';
    clearTimeout(state.heartTimer);
    state.heartTimer = setTimeout(function () {
      el.classList.add('hidden');
    }, 680);
  }

  function toggleCurrentLike() {
    var v = state.videos[state.currentIdx];
    if (!v) return;
    var list = readFavs();
    var existed = false;
    var next = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === v.id) existed = true;
      else next.push(list[i]);
    }
    if (!existed) {
      next.unshift(v);
      if (next.length > 60) next = next.slice(0, 60);
      triggerHeartBurst();
      showToast('♥ Đã lưu vào danh sách Yêu thích');
    } else {
      showToast('Đã bỏ khỏi Yêu thích');
    }
    writeFavs(next);
    updateLikeButton(v);
  }

  function updateLikeButton(v) {
    var liked = v ? isFav(v.id) : false;
    $('btn-like').classList.toggle('active', liked);
    var baseCount = v && v.stats ? Number(v.stats.diggCount || 0) : 0;
    var disp = formatCount(baseCount + (liked ? 1 : 0));
    $('like-count').textContent = disp;
    if ($('stat-likes')) $('stat-likes').textContent = disp;
  }

  // ===== NATIVE WEBOS SERVICE BOOTSTRAP =====
  function waitForLocalProxy(onReady, maxTries) {
    maxTries = maxTries || 22;
    var tries = 0;
    var base = getApiBase();

    function ping() {
      tries += 1;
      fetch(base + '/api/health', { cache: 'no-store' })
        .then(function (r) {
          if (r && r.ok) onReady(true);
          else if (tries < maxTries) setTimeout(ping, 350);
          else onReady(false);
        })
        .catch(function () {
          if (tries < maxTries) {
            if (tries === 3) $('loading-text').textContent = 'Đang khởi động dịch vụ TikTok trên TV...';
            setTimeout(ping, 350);
          } else {
            onReady(false);
          }
        });
    }
    ping();
  }

  function ensureNativeService(onReady) {
    var started = false;
    function go() {
      if (started) return;
      started = true;
      waitForLocalProxy(onReady, 22);
    }

    if (typeof window.PalmServiceBridge !== 'function') {
      go();
      return;
    }

    var fallback = setTimeout(go, 1200);
    try {
      var bridge = new window.PalmServiceBridge();
      state.serviceBridge = bridge;
      bridge.onservicecallback = function () {
        clearTimeout(fallback);
        go();
      };
      bridge.call('luna://com.giadinh.tiktoktv.service/start', JSON.stringify({ subscribe: true }));
    } catch (e) {
      clearTimeout(fallback);
      go();
    }
  }

  // ===== CATEGORIES =====
  function loadCategories() {
    fetch(getApiBase() + '/api/categories')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var cats = (d && Array.isArray(d.categories)) ? d.categories : [];
        cats.push({ id: 'favs', name: 'Đã thích', icon: '❤️' });
        state.categories = cats;
        renderCategories();
      })
      .catch(function () {
        state.categories = [
          { id: 120, name: 'Đề xuất', icon: '🔥' },
          { id: 104, name: 'Hài hước', icon: '😂' },
          { id: 119, name: 'Ca hát & Nhảy', icon: '🎵' },
          { id: 'favs', name: 'Đã thích', icon: '❤️' }
        ];
        renderCategories();
      });
  }

  function renderCategories() {
    var box = $('category-list');
    box.innerHTML = '';
    if ($('cat-count-badge')) $('cat-count-badge').textContent = String(state.categories.length);
    for (var i = 0; i < state.categories.length; i++) {
      (function (cat) {
        var btn = document.createElement('button');
        btn.className = 'cat-btn focusable' + (String(state.activeCatId) === String(cat.id) ? ' active' : '');
        btn.setAttribute('data-cat', String(cat.id));
        btn.innerHTML = '<span class="cat-ic">' + escapeHtml(cat.icon || '🎬') + '</span><span>' + escapeHtml(cat.name) + '</span>';
        btn.addEventListener('click', function () {
          selectCategory(cat);
        });
        box.appendChild(btn);
      })(state.categories[i]);
    }
  }

  function selectCategory(cat) {
    state.activeCatId = cat.id;
    state.activeCatLabel = (cat.icon || '🎬') + ' ' + cat.name;
    $('stage-cat-pill').textContent = state.activeCatLabel;
    closeComments();

    var btns = $('category-list').querySelectorAll('.cat-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute('data-cat') === String(cat.id));
    }

    if (cat.id === 'favs') {
      var favs = readFavs();
      state.videos = favs;
      state.currentIdx = -1;
      if (!favs.length) {
        stopVideo();
        renderUpNext();
        showError('Bạn chưa lưu video yêu thích nào. Hãy bấm ♥ để lưu!');
        return;
      }
      playVideoAt(0);
      return;
    }

    state.videos = [];
    state.currentIdx = -1;
    renderUpNext();
    fetchMoreVideos(true);
  }

  // ===== FEED FETCHING =====
  function fetchMoreVideos(autoPlayFirst) {
    if (state.isFetching || state.activeCatId === 'favs') return;
    state.isFetching = true;
    if (autoPlayFirst) {
      $('error-overlay').classList.add('hidden');
      $('loading-overlay').classList.remove('hidden');
      $('loading-text').textContent = 'Đang tải video ' + state.activeCatLabel + '...';
    }

    var reqCat = state.activeCatId;
    fetch(getApiBase() + '/api/feed?cat=' + encodeURIComponent(reqCat) + '&count=14')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.isFetching = false;
        if (String(state.activeCatId) !== String(reqCat)) return;

        var incoming = (data && Array.isArray(data.items)) ? data.items : [];
        var existing = {};
        for (var i = 0; i < state.videos.length; i++) existing[state.videos[i].id] = true;

        for (var j = 0; j < incoming.length; j++) {
          if (!existing[incoming[j].id]) {
            existing[incoming[j].id] = true;
            state.videos.push(incoming[j]);
          }
        }

        updateCounter();
        renderUpNext();
        if (autoPlayFirst) {
          if (state.videos.length > 0) {
            playVideoAt(0);
          } else {
            showError('Không tải được danh sách video TikTok. Vui lòng thử lại.');
          }
        }
      })
      .catch(function (err) {
        state.isFetching = false;
        sendClientLog('FEED-ERR', err && err.message ? err.message : String(err));
        if (autoPlayFirst) {
          showError('Lỗi kết nối dịch vụ TikTok nội bộ (cổng 5070).');
        }
      });
  }

  // ===== UP NEXT PREVIEW LIST =====
  function renderUpNext() {
    var box = $('upnext-list');
    if (!box) return;
    box.innerHTML = '';

    var start = state.currentIdx + 1;
    var count = 0;
    for (var i = start; i < state.videos.length && count < 6; i++) {
      (function (v, idx) {
        var row = document.createElement('button');
        row.className = 'upnext-row focusable';
        row.innerHTML =
          '<img class="upnext-thumb" loading="lazy" src="' + escapeHtml(v.cover || 'icon.png') + '" alt="">' +
          '<div class="upnext-info">' +
            '<div class="upnext-author">@' + escapeHtml(v.author ? v.author.uniqueId : 'tiktok') + '</div>' +
            '<div class="upnext-desc">' + escapeHtml(v.desc || 'Video TikTok') + '</div>' +
            '<div class="upnext-meta">♥ ' + formatCount(v.stats ? v.stats.diggCount : 0) + ' • ▶ ' + formatCount(v.stats ? v.stats.playCount : 0) + '</div>' +
          '</div>';
        row.addEventListener('click', function () {
          playVideoAt(idx);
        });
        box.appendChild(row);
      })(state.videos[i], i);
      count += 1;
    }

    if ($('upnext-badge')) {
      $('upnext-badge').textContent = count > 0 ? (count + ' video') : 'Đang nạp';
    }
  }

  // ===== SINGLE HARDWARE VIDEO PLAYER (LG WEBOS 6.0 SAFE) =====
  function stopVideo() {
    var vid = $('tv-video');
    if (!vid) return;
    try {
      vid.pause();
      vid.removeAttribute('src');
      vid.load();
    } catch (e) {}
    $('music-disc').classList.remove('spinning');
  }

  function showError(msg) {
    $('loading-overlay').classList.add('hidden');
    $('error-text').textContent = msg;
    $('error-overlay').classList.remove('hidden');
    setFocus($('btn-retry'));
  }

  function updateCounter() {
    var cur = state.currentIdx >= 0 ? (state.currentIdx + 1) : 0;
    $('stage-counter').textContent = cur + ' / ' + state.videos.length;
  }

  function playVideoAt(idx) {
    if (!state.videos.length) return;
    if (idx < 0) idx = 0;
    if (idx >= state.videos.length) {
      showToast('Đang tải thêm video mới...');
      fetchMoreVideos(false);
      return;
    }

    state.currentIdx = idx;
    var v = state.videos[idx];
    updateCounter();
    renderUpNext();

    $('error-overlay').classList.add('hidden');
    $('loading-overlay').classList.remove('hidden');
    $('loading-text').textContent = 'Đang phát video...';
    $('video-progress-fill').style.width = '0%';
    $('meta-time').textContent = '00:00 / ' + formatSec(v.duration || 0);

    // Update phone stage metadata
    var handle = '@' + (v.author ? v.author.uniqueId : 'tiktok');
    var nick = (v.author && v.author.nickname) ? v.author.nickname : handle;
    var avatar = (v.author && v.author.avatar) ? v.author.avatar : 'icon.png';

    $('meta-author').textContent = handle;
    $('meta-verified').classList.toggle('hidden', !(v.author && v.author.verified));
    $('meta-desc').textContent = v.desc || 'Video TikTok';
    $('meta-music-text').textContent = (v.music && v.music.title) ? v.music.title : 'Âm thanh gốc';
    $('meta-avatar').src = avatar;
    $('comment-count').textContent = formatCount(v.stats ? v.stats.commentCount : 0);

    // Update right panel creator & stats card
    if ($('card-avatar')) $('card-avatar').src = avatar;
    if ($('card-nickname')) $('card-nickname').textContent = nick;
    if ($('card-handle')) $('card-handle').textContent = handle;
    if ($('card-full-desc')) $('card-full-desc').textContent = v.desc || 'Không có mô tả.';
    if ($('stat-comments')) $('stat-comments').textContent = formatCount(v.stats ? v.stats.commentCount : 0);
    if ($('stat-shares')) $('stat-shares').textContent = formatCount(v.stats ? v.stats.shareCount : 0);
    if ($('stat-plays')) $('stat-plays').textContent = formatCount(v.stats ? v.stats.playCount : 0);
    updateLikeButton(v);

    // Swap src on the SINGLE <video> element to never exhaust LG TV hardware decoders
    var vid = $('tv-video');
    try {
      vid.pause();
      vid.muted = state.muted;
      vid.loop = !state.autoNext;
      vid.src = v.videoUrl;
      vid.load();
      vid.play().catch(function (err) {
        sendClientLog('PLAY-ERR', err && err.message ? err.message : String(err));
      });
    } catch (e) {}

    if (state.commentsOpen) {
      loadCommentsForCurrent();
    }

    if (state.activeCatId !== 'favs' && (state.videos.length - idx) <= 4) {
      fetchMoreVideos(false);
    }
  }

  function nextVideo() {
    if (state.currentIdx + 1 < state.videos.length) {
      playVideoAt(state.currentIdx + 1);
    } else if (state.activeCatId !== 'favs') {
      showToast('Đang tải thêm video mới...');
      fetchMoreVideos(false);
    } else if (state.videos.length > 0) {
      playVideoAt(0);
    }
  }

  function prevVideo() {
    if (state.currentIdx > 0) {
      playVideoAt(state.currentIdx - 1);
    } else {
      showToast('Đang ở video đầu tiên', 1400);
    }
  }

  function seekBy(sec) {
    var vid = $('tv-video');
    if (!vid || !isFinite(vid.duration) || vid.duration <= 0) return;
    vid.currentTime = Math.max(0, Math.min(vid.duration - 0.3, vid.currentTime + sec));
    showToast((sec >= 0 ? '⏩ +' : '⏪ ') + sec + 's', 1000);
  }

  function togglePlayPause() {
    var vid = $('tv-video');
    if (!vid || !vid.src) return;
    if (vid.paused) {
      vid.play().catch(function () {});
      flashPlayBadge('▶');
    } else {
      vid.pause();
      flashPlayBadge('⏸');
    }
  }

  function flashPlayBadge(icon) {
    var b = $('play-badge');
    b.textContent = icon;
    b.classList.remove('hidden');
    clearTimeout(state.playBadgeTimer);
    state.playBadgeTimer = setTimeout(function () {
      b.classList.add('hidden');
    }, 650);
  }

  function toggleAutoNext() {
    state.autoNext = !state.autoNext;
    var vid = $('tv-video');
    if (vid) vid.loop = !state.autoNext;
    if ($('autonext-svg')) $('autonext-svg').innerHTML = state.autoNext ? SVG_AUTONEXT : SVG_REPEAT;
    $('autonext-label').textContent = state.autoNext ? 'Tự lướt' : 'Lặp lại';
    $('btn-autonext').classList.toggle('active', state.autoNext);
    showToast(state.autoNext ? '⏭ Bật tự động chuyển video tiếp' : '🔁 Chế độ lặp lại video hiện tại', 1800);
  }

  function toggleMute() {
    state.muted = !state.muted;
    var vid = $('tv-video');
    if (vid) vid.muted = state.muted;
    if ($('mute-svg')) $('mute-svg').innerHTML = state.muted ? SVG_MUTE_OFF : SVG_MUTE_ON;
    $('mute-label').textContent = state.muted ? 'Đã tắt' : 'Âm thanh';
    $('btn-mute').classList.toggle('active', state.muted);
    showToast(state.muted ? '🔇 Đã tắt tiếng' : '🔊 Đã bật tiếng', 1400);
  }

  function toggleTheaterMode(forceVal) {
    state.theaterMode = typeof forceVal === 'boolean' ? forceVal : !state.theaterMode;
    document.body.classList.toggle('theater-mode', state.theaterMode);
    $('btn-exit-theater').classList.toggle('hidden', !state.theaterMode);
    if (state.theaterMode) {
      showToast('🎬 Chế độ Rạp — bấm ▲▼ lướt, OK tạm dừng, 🔵 hoặc BACK để thoát', 2600);
      setFocus($('btn-like'));
    } else {
      setFocus($('btn-play-pause'));
    }
  }

  // ===== LIVE COMMENTS =====
  function openComments() {
    if (state.theaterMode) toggleTheaterMode(false);
    state.commentsOpen = true;
    $('guide-pane').classList.add('hidden');
    $('comments-pane').classList.remove('hidden');
    loadCommentsForCurrent();
    setFocus($('btn-close-comments'));
  }

  function closeComments() {
    state.commentsOpen = false;
    $('comments-pane').classList.add('hidden');
    $('guide-pane').classList.remove('hidden');
  }

  function loadCommentsForCurrent() {
    var v = state.videos[state.currentIdx];
    if (!v) return;
    var listEl = $('comments-list');
    var st = $('comments-status');
    listEl.innerHTML = '';
    st.textContent = 'Đang tải bình luận...';
    st.classList.remove('hidden');
    $('comments-title').textContent = '💬 Bình luận (' + formatCount(v.stats ? v.stats.commentCount : 0) + ')';

    var targetId = v.id;
    fetch(getApiBase() + '/api/comments?id=' + encodeURIComponent(targetId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var cur = state.videos[state.currentIdx];
        if (!cur || cur.id !== targetId) return;
        var arr = (data && Array.isArray(data.comments)) ? data.comments : [];
        if (!arr.length) {
          st.textContent = 'Chưa có bình luận nào cho video này.';
          return;
        }
        st.classList.add('hidden');
        for (var i = 0; i < arr.length; i++) {
          var c = arr[i];
          var card = document.createElement('div');
          card.className = 'comment-card';
          card.innerHTML =
            '<img class="comment-av" src="' + escapeHtml((c.user && c.user.avatar) || 'icon.png') + '" alt="">' +
            '<div class="comment-body">' +
              '<div class="comment-user">' + escapeHtml((c.user && c.user.nickname) || 'TikToker') + '</div>' +
              '<div class="comment-text">' + escapeHtml(c.text) + '</div>' +
              '<div class="comment-likes">♥ ' + formatCount(c.likes) + '</div>' +
            '</div>';
          listEl.appendChild(card);
        }
      })
      .catch(function () {
        st.textContent = 'Không tải được bình luận.';
      });
  }

  // ===== SPATIAL TV D-PAD NAVIGATION =====
  function getVisibleFocusables() {
    var all = document.querySelectorAll('.focusable');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].offsetParent !== null && !all[i].disabled) out.push(all[i]);
    }
    return out;
  }

  function setFocus(el) {
    if (!el) return;
    if (state.focusedEl && state.focusedEl !== el) state.focusedEl.classList.remove('tv-focused');
    state.focusedEl = el;
    el.classList.add('tv-focused');
    try {
      el.focus({ preventScroll: true });
      if (el.classList.contains('cat-btn')) {
        var box = $('category-list');
        if (box) {
          var t = el.offsetTop - Math.floor(box.clientHeight * 0.35);
          box.scrollTop = t > 0 ? t : 0;
        }
      } else if (el.classList.contains('upnext-row')) {
        var ubox = $('upnext-list');
        if (ubox) {
          var ut = el.offsetTop - Math.floor(ubox.clientHeight * 0.35);
          ubox.scrollTop = ut > 0 ? ut : 0;
        }
      }
    } catch (e) {}
  }

  function moveFocusDirection(direction) {
    var list = getVisibleFocusables();
    if (!list.length) return;
    var current = state.focusedEl || document.activeElement;
    if (!current || list.indexOf(current) === -1) {
      setFocus($('btn-play-pause') || list[0]);
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
      var valid = false;
      var pDist = 0;
      var sDist = 0;

      if (direction === 'right' && dx > 10) { valid = true; pDist = dx; sDist = Math.abs(dy); }
      else if (direction === 'left' && dx < -10) { valid = true; pDist = -dx; sDist = Math.abs(dy); }
      else if (direction === 'down' && dy > 10) { valid = true; pDist = dy; sDist = Math.abs(dx); }
      else if (direction === 'up' && dy < -10) { valid = true; pDist = -dy; sDist = Math.abs(dx); }

      if (valid) {
        var score = pDist + sDist * 2.4;
        if (score < bestScore) { bestScore = score; bestEl = cand; }
      }
    }
    if (bestEl) setFocus(bestEl);
  }

  function isInScrollList(el) {
    if (!el) return false;
    return Boolean(
      ($('left-panel') && $('left-panel').contains(el)) ||
      ($('upnext-list') && $('upnext-list').contains(el))
    );
  }

  function setupKeyboardAndRemote() {
    document.addEventListener('keydown', function (e) {
      var key = e.key;
      var code = e.keyCode || e.which;

      // Back / Escape
      if (code === 461 || key === 'Escape' || key === 'Backspace') {
        e.preventDefault();
        if (state.theaterMode) {
          toggleTheaterMode(false);
        } else if (state.commentsOpen) {
          closeComments();
          setFocus($('btn-play-pause'));
        } else if (isInScrollList(state.focusedEl)) {
          setFocus($('btn-play-pause'));
        } else if (window.webOS && window.webOS.platformBack) {
          stopVideo();
          window.webOS.platformBack();
        }
        return;
      }

      // LG Magic Remote Color & Media Keys
      if (code === 403) { e.preventDefault(); toggleCurrentLike(); return; } // Red
      if (code === 404) { e.preventDefault(); state.commentsOpen ? closeComments() : openComments(); return; } // Green
      if (code === 405) { e.preventDefault(); toggleAutoNext(); return; } // Yellow
      if (code === 406 || key === 'f' || key === 'F') { e.preventDefault(); toggleTheaterMode(); return; } // Blue / F
      if (code === 415) { e.preventDefault(); $('tv-video').play().catch(function () {}); return; } // Play
      if (code === 19) { e.preventDefault(); $('tv-video').pause(); return; } // Pause
      if (code === 417) { e.preventDefault(); seekBy(5); return; } // FF
      if (code === 412) { e.preventDefault(); seekBy(-5); return; } // RW

      // Scroll comments when open
      if (state.commentsOpen && state.focusedEl === $('btn-close-comments')) {
        if (key === 'ArrowDown' || code === 40) { e.preventDefault(); $('comments-list').scrollTop += 120; return; }
        if (key === 'ArrowUp' || code === 38) { e.preventDefault(); $('comments-list').scrollTop -= 120; return; }
      }

      if (key === 'ArrowDown' || key === 'Down' || code === 40) {
        e.preventDefault();
        if (isInScrollList(state.focusedEl)) moveFocusDirection('down');
        else nextVideo();
        return;
      }
      if (key === 'ArrowUp' || key === 'Up' || code === 38) {
        e.preventDefault();
        if (isInScrollList(state.focusedEl)) moveFocusDirection('up');
        else prevVideo();
        return;
      }
      if (key === 'ArrowLeft' || key === 'Left' || code === 37) {
        e.preventDefault();
        moveFocusDirection('left');
        return;
      }
      if (key === 'ArrowRight' || key === 'Right' || code === 39) {
        e.preventDefault();
        moveFocusDirection('right');
        return;
      }
      if (key === ' ' && state.focusedEl === $('btn-play-pause')) {
        e.preventDefault();
        togglePlayPause();
      }
    });

    window.addEventListener('wheel', function (e) {
      if (state.commentsOpen && $('comments-pane').contains(e.target)) return;
      if ($('left-panel') && $('left-panel').contains(e.target)) return;
      if ($('upnext-list') && $('upnext-list').contains(e.target)) return;
      if (state.wheelLock) return;
      state.wheelLock = true;
      setTimeout(function () { state.wheelLock = false; }, 420);
      if (e.deltaY > 10) nextVideo();
      else if (e.deltaY < -10) prevVideo();
    }, { passive: true });
  }

  function bindEvents() {
    $('btn-like').addEventListener('click', toggleCurrentLike);
    $('btn-comments').addEventListener('click', function () {
      if (state.commentsOpen) closeComments();
      else openComments();
    });
    $('btn-close-comments').addEventListener('click', function () {
      closeComments();
      setFocus($('btn-play-pause'));
    });
    $('btn-autonext').addEventListener('click', toggleAutoNext);
    $('btn-mute').addEventListener('click', toggleMute);
    $('btn-theater').addEventListener('click', function () { toggleTheaterMode(true); });
    $('btn-exit-theater').addEventListener('click', function () { toggleTheaterMode(false); });
    $('btn-prev-video').addEventListener('click', prevVideo);
    $('btn-next-video').addEventListener('click', nextVideo);
    $('btn-play-pause').addEventListener('click', togglePlayPause);
    $('btn-reload-feed').addEventListener('click', function () {
      state.videos = [];
      state.currentIdx = -1;
      fetchMoreVideos(true);
    });
    $('btn-retry').addEventListener('click', function () {
      fetchMoreVideos(true);
    });
    $('tv-video').addEventListener('click', togglePlayPause);
    $('video-progress-track').addEventListener('click', function (e) {
      var vid = $('tv-video');
      if (!vid || !isFinite(vid.duration) || vid.duration <= 0) return;
      var rect = this.getBoundingClientRect();
      var ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      vid.currentTime = ratio * vid.duration;
    });

    var vid = $('tv-video');
    vid.addEventListener('playing', function () {
      $('loading-overlay').classList.add('hidden');
      $('btn-play-pause').textContent = '⏸ Dừng';
      $('music-disc').classList.add('spinning');
    });
    vid.addEventListener('pause', function () {
      $('btn-play-pause').textContent = '▶ Phát';
      $('music-disc').classList.remove('spinning');
    });
    vid.addEventListener('waiting', function () {
      $('loading-overlay').classList.remove('hidden');
      $('loading-text').textContent = 'Đang đệm video...';
    });
    vid.addEventListener('timeupdate', function () {
      if (!isFinite(vid.duration) || vid.duration <= 0) return;
      var cur = vid.currentTime || 0;
      var pct = Math.min(100, (cur / vid.duration) * 100);
      $('video-progress-fill').style.width = pct + '%';
      $('meta-time').textContent = formatSec(cur) + ' / ' + formatSec(vid.duration);
    });
    vid.addEventListener('ended', function () {
      if (state.autoNext) {
        nextVideo();
      }
    });
    vid.addEventListener('error', function () {
      sendClientLog('VIDEO-ELEM-ERR', state.videos[state.currentIdx] ? state.videos[state.currentIdx].id : 'none');
      showToast('Video lỗi luồng — tự chuyển video tiếp theo...', 1800);
      setTimeout(nextVideo, 600);
    });

    window.addEventListener('pagehide', stopVideo);
  }

  function init() {
    $('btn-autonext').classList.add('active');
    bindEvents();
    setupKeyboardAndRemote();
    ensureNativeService(function (ok) {
      sendClientLog('APP-INIT', {
        app: 'TikTok TV v1.1.0',
        ua: navigator.userAgent,
        proxyOk: ok,
        nativeBridge: typeof window.PalmServiceBridge === 'function'
      });
      if (!ok) {
        showError('Không kết nối được dịch vụ TikTok nội bộ trên TV (cổng 5070).');
        return;
      }
      loadCategories();
      fetchMoreVideos(true);
      setFocus($('btn-play-pause'));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
