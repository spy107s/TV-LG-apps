(function () {
  'use strict';

  var STORAGE_KEYS = {
    FAVS: 'zmp3_tv_favorites',
    RECENT: 'zmp3_tv_recent'
  };

  var state = {
    activeView: 'home',
    homeData: null,
    newReleaseTab: 'all',
    chartData: null,
    chartTab: 'rt',
    top100Data: null,
    hubData: null,
    hubDetailOpen: false,
    libraryTab: 'favorites',
    currentPlaylist: null,
    queueTitle: 'Danh sách phát',
    queue: [],
    queueIdx: -1,
    currentSong: null,
    lyrics: [],
    activeLyricIdx: -1,
    shuffle: false,
    repeat: false,
    nowRightTab: 'lyrics',
    serviceBridge: null,
    toastTimer: null,
    focusedEl: null,
    skipCount: 0,
    ambientOpen: false,
    ambientTopic: 'rainy',
    ambientSource: 'giphy',
    ambientReqId: 0,
    ambientGifs: [],
    ambientGifIdx: -1,
    ambientGifSlot: 'a',
    ambientGifTimer: null,
    ambientClockTimer: null,
    ambientWeatherTimer: null,
    ambientCalMonthKey: '',
    audioCtx: null,
    audioSource: null,
    analyser: null,
    vizData: null,
    vizPeaks: null,
    vizRafId: null
  };

  function getApiBase() {
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      return '';
    }
    return 'http://127.0.0.1:5030';
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
    }, duration || 2800);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return '00:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return (m < 10 ? '0' + m : '' + m) + ':' + (s < 10 ? '0' + s : '' + s);
  }

  // ===== STORAGE (FAVORITES & RECENT) =====
  function readList(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function writeList(key, list) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch (e) {}
  }

  function isFavorite(songId) {
    if (!songId) return false;
    var favs = readList(STORAGE_KEYS.FAVS);
    for (var i = 0; i < favs.length; i++) {
      if (favs[i].id === songId) return true;
    }
    return false;
  }

  function toggleFavorite(song) {
    if (!song || !song.id) return;
    var favs = readList(STORAGE_KEYS.FAVS);
    var exists = false;
    var next = [];
    for (var i = 0; i < favs.length; i++) {
      if (favs[i].id === song.id) exists = true;
      else next.push(favs[i]);
    }
    if (!exists) {
      next.unshift(song);
      if (next.length > 80) next = next.slice(0, 80);
      showToast('❤️ Đã thêm vào Yêu thích: ' + song.title);
    } else {
      showToast('🤍 Đã bỏ khỏi Yêu thích: ' + song.title);
    }
    writeList(STORAGE_KEYS.FAVS, next);
    updateFavButtons();
    if (state.activeView === 'library') renderLibrary();
  }

  function addToRecent(song) {
    if (!song || !song.id) return;
    var list = readList(STORAGE_KEYS.RECENT).filter(function (x) { return x.id !== song.id; });
    list.unshift(song);
    if (list.length > 50) list = list.slice(0, 50);
    writeList(STORAGE_KEYS.RECENT, list);
  }

  function updateFavButtons() {
    var fav = state.currentSong ? isFavorite(state.currentSong.id) : false;
    var icon = fav ? '❤️' : '🤍';
    if ($('mini-fav-btn')) $('mini-fav-btn').textContent = icon;
    if ($('now-fav-btn')) $('now-fav-btn').textContent = icon;
  }

  // ===== WEBOS NATIVE PROXY BOOTSTRAP =====
  function waitForLocalProxy(onReady, maxTries) {
    maxTries = maxTries || 20;
    var tries = 0;
    var base = getApiBase();

    function checkOnce() {
      tries += 1;
      fetch(base + '/api/health', { cache: 'no-store' })
        .then(function (r) {
          if (r && r.ok) onReady(true);
          else if (tries < maxTries) setTimeout(checkOnce, 350);
          else onReady(false);
        })
        .catch(function () {
          if (tries < maxTries) {
            if ($('home-status-sub') && tries === 3) {
              $('home-status-sub').textContent = 'Đang khởi động dịch vụ nhạc Zing MP3 trên TV...';
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
    var polled = false;
    function startPoll() {
      if (polled) return;
      polled = true;
      waitForLocalProxy(function (ok) {
        if (typeof onReady === 'function') onReady(ok);
      }, 20);
    }

    if (typeof window.PalmServiceBridge !== 'function') {
      startPoll();
      return;
    }

    var fallback = setTimeout(startPoll, 1200);
    try {
      var bridge = new window.PalmServiceBridge();
      state.serviceBridge = bridge;
      bridge.onservicecallback = function () {
        clearTimeout(fallback);
        startPoll();
      };
      bridge.call('luna://com.giadinh.zingmp3tv.service/start', JSON.stringify({ subscribe: true }));
    } catch (e) {
      clearTimeout(fallback);
      startPoll();
    }
  }

  // ===== UI CARD BUILDERS =====
  function createSongCard(song, listRef, indexInList, rankNum) {
    var btn = document.createElement('button');
    btn.className = 'song-item focusable' + (state.currentSong && state.currentSong.id === song.id ? ' playing' : '');
    btn.setAttribute('data-song-id', song.id);

    var rankHtml = '';
    if (typeof rankNum === 'number') {
      var rCls = 'chart-rank' + (rankNum === 1 ? ' top1' : (rankNum === 2 ? ' top2' : (rankNum === 3 ? ' top3' : '')));
      var rTxt = rankNum < 10 ? ('0' + rankNum) : String(rankNum);
      rankHtml = '<div class="' + rCls + '">' + rTxt + '</div>';
    }

    var vipHtml = song.isVip ? '<span class="vip-pill">VIP</span>' : '';
    var durHtml = song.duration ? '<span class="song-dur">' + formatTime(song.duration) + '</span>' : '';

    btn.innerHTML =
      rankHtml +
      '<img class="song-thumb" loading="lazy" src="' + escapeHtml(song.thumbnail || 'icon.png') + '" alt="">' +
      '<div class="song-info">' +
        '<div class="song-title">' + escapeHtml(song.title) + '</div>' +
        '<div class="song-artist">' + escapeHtml(song.artists) + '</div>' +
      '</div>' +
      '<div class="song-right">' + vipHtml + durHtml + '</div>';

    btn.addEventListener('click', function () {
      playFromList(listRef || [song], typeof indexInList === 'number' ? indexInList : 0, true);
    });
    return btn;
  }

  function createPlaylistCard(pl) {
    var btn = document.createElement('button');
    btn.className = 'playlist-card focusable';
    btn.innerHTML =
      '<div class="playlist-art-wrap">' +
        '<img class="playlist-art" loading="lazy" src="' + escapeHtml(pl.thumbnail || 'icon.png') + '" alt="">' +
      '</div>' +
      '<div class="playlist-body">' +
        '<div class="playlist-title">' + escapeHtml(pl.title) + '</div>' +
        '<div class="playlist-sub">' + escapeHtml(pl.subtitle || 'Zing MP3 Playlist') + '</div>' +
      '</div>';

    btn.addEventListener('click', function () {
      openPlaylist(pl);
    });
    return btn;
  }

  function updateSubTabs(containerId, attr, val) {
    var box = $(containerId);
    if (!box) return;
    var btns = box.querySelectorAll('.sub-tab');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute(attr) === val);
    }
  }

  function highlightActiveSongs() {
    var curId = state.currentSong ? state.currentSong.id : '';
    var els = document.querySelectorAll('.song-item');
    for (var i = 0; i < els.length; i++) {
      els[i].classList.toggle('playing', Boolean(curId) && els[i].getAttribute('data-song-id') === curId);
    }
  }

  // ===== VIEWS & DATA LOADING =====
  function switchView(viewName) {
    state.activeView = viewName;
    var views = document.querySelectorAll('.view');
    for (var i = 0; i < views.length; i++) {
      views[i].classList.remove('active');
    }
    var target = $('view-' + viewName);
    if (target) target.classList.add('active');

    var navs = document.querySelectorAll('.nav-item');
    for (var j = 0; j < navs.length; j++) {
      navs[j].classList.toggle('active', navs[j].getAttribute('data-nav') === viewName);
    }

    if (viewName === 'chart') loadChartData();
    else if (viewName === 'top100') loadTop100Data();
    else if (viewName === 'hub') loadHubData();
    else if (viewName === 'library') renderLibrary();
  }

  function loadHomeData() {
    $('home-status-sub').textContent = 'Đang tải danh sách nhạc mới và tuyển tập chọn lọc...';
    fetch(getApiBase() + '/api/home')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || data.error) {
          $('home-status-sub').textContent = 'Không tải được dữ liệu Zing MP3. Vui lòng thử lại.';
          return;
        }
        state.homeData = data;
        $('home-status-sub').textContent = 'Sẵn sàng • Nhạc mới phát hành, BXH #zingchart, Top 100 và lời bài hát đồng bộ.';
        renderNewReleases(state.newReleaseTab);

        var plBox = $('home-playlists');
        plBox.innerHTML = '';
        var sections = Array.isArray(data.playlistSections) ? data.playlistSections : [];
        for (var i = 0; i < sections.length; i++) {
          var sec = sections[i];
          var block = document.createElement('div');
          block.className = 'section-block';
          var h2 = document.createElement('h2');
          h2.className = 'section-title';
          h2.textContent = '💿 ' + sec.title;
          var row = document.createElement('div');
          row.className = 'playlist-row';
          (sec.items || []).forEach(function (pl) {
            row.appendChild(createPlaylistCard(pl));
          });
          block.appendChild(h2);
          block.appendChild(row);
          plBox.appendChild(block);
        }
      })
      .catch(function (err) {
        sendClientLog('HOME-ERR', err.message || String(err));
        $('home-status-sub').textContent = 'Lỗi kết nối máy chủ Zing MP3 nội bộ (cổng 5030).';
        showToast('Không thể kết nối máy chủ Zing MP3.');
      });
  }

  function renderNewReleases(tabKey) {
    state.newReleaseTab = tabKey || 'all';
    updateSubTabs('new-release-tabs', 'data-nr', state.newReleaseTab);
    var grid = $('grid-new-release');
    grid.innerHTML = '';
    if (!state.homeData || !state.homeData.newReleases) return;
    var list = state.homeData.newReleases[state.newReleaseTab] || [];
    for (var i = 0; i < list.length; i++) {
      grid.appendChild(createSongCard(list[i], list, i));
    }
  }

  function loadChartData(autoPlayFirst) {
    if (state.chartData) {
      renderChartTab(state.chartTab);
      if (autoPlayFirst) playFirstFreeInList(state.chartData.rtChart || []);
      return;
    }
    var st = $('chart-status');
    st.textContent = 'Đang tải bảng xếp hạng #zingchart...';
    st.classList.remove('hidden');

    fetch(getApiBase() + '/api/chart')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.chartData = data;
        st.classList.add('hidden');
        renderChartTab(state.chartTab);
        if (autoPlayFirst) playFirstFreeInList(data.rtChart || []);
      })
      .catch(function () {
        st.textContent = 'Không tải được bảng xếp hạng #zingchart.';
        st.classList.remove('hidden');
      });
  }

  function renderChartTab(tabKey) {
    state.chartTab = tabKey || 'rt';
    updateSubTabs('chart-tabs', 'data-chart', state.chartTab);
    var container = $('list-chart');
    container.innerHTML = '';
    if (!state.chartData) return;

    var list = [];
    if (state.chartTab === 'rt') list = state.chartData.rtChart || [];
    else if (state.chartData.weekCharts) list = state.chartData.weekCharts[state.chartTab] || [];

    for (var i = 0; i < list.length; i++) {
      container.appendChild(createSongCard(list[i], list, i, i + 1));
    }
  }

  function loadTop100Data() {
    if (state.top100Data) return;
    var st = $('top100-status');
    st.textContent = 'Đang tải danh sách Top 100...';
    st.classList.remove('hidden');

    fetch(getApiBase() + '/api/top100')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.top100Data = data;
        st.classList.add('hidden');
        var box = $('top100-container');
        box.innerHTML = '';
        var groups = (data && Array.isArray(data.groups)) ? data.groups : [];
        groups.forEach(function (grp) {
          var sec = document.createElement('div');
          sec.className = 'section-block';
          var h3 = document.createElement('h3');
          h3.className = 'sub-section-title';
          h3.textContent = grp.title;
          var grid = document.createElement('div');
          grid.className = 'playlist-grid';
          (grp.items || []).forEach(function (pl) {
            grid.appendChild(createPlaylistCard(pl));
          });
          sec.appendChild(h3);
          sec.appendChild(grid);
          box.appendChild(sec);
        });
      })
      .catch(function () {
        st.textContent = 'Không tải được Top 100.';
        st.classList.remove('hidden');
      });
  }

  // ===== CHỦ ĐỀ & THỂ LOẠI (HUB) =====
  function createHubCard(item) {
    var btn = document.createElement('button');
    btn.className = 'hub-card focusable';
    btn.innerHTML =
      '<img class="hub-card-img" loading="lazy" src="' + escapeHtml(item.cover || 'icon.png') + '" alt="">' +
      '<div class="hub-card-shade"></div>' +
      '<div class="hub-card-title">' + escapeHtml(item.title) + '</div>';
    btn.addEventListener('click', function () {
      openHubDetail(item);
    });
    return btn;
  }

  function loadHubData() {
    if (state.hubDetailOpen) {
      closeHubDetail();
    }
    if (state.hubData) return;

    var st = $('hub-status');
    st.textContent = 'Đang tải Chủ đề & Thể loại từ Zing MP3...';
    st.classList.remove('hidden');

    fetch(getApiBase() + '/api/hub')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.hubData = data;
        st.classList.add('hidden');

        var topics = (data && Array.isArray(data.topics)) ? data.topics : [];
        if (topics.length) {
          var tGrid = $('hub-topics-grid');
          tGrid.innerHTML = '';
          topics.forEach(function (t) { tGrid.appendChild(createHubCard(t)); });
          $('hub-topics-section').classList.remove('hidden');
        }

        var nations = (data && Array.isArray(data.nations)) ? data.nations : [];
        if (nations.length) {
          var nGrid = $('hub-nations-grid');
          nGrid.innerHTML = '';
          nations.forEach(function (n) { nGrid.appendChild(createHubCard(n)); });
          $('hub-nations-section').classList.remove('hidden');
        }

        var gBox = $('hub-genres-container');
        gBox.innerHTML = '';
        var genres = (data && Array.isArray(data.genres)) ? data.genres : [];
        genres.forEach(function (g) {
          if (!g.playlists || !g.playlists.length) return;
          var sec = document.createElement('div');
          sec.className = 'section-block';
          var head = document.createElement('div');
          head.className = 'section-header-row';
          var h3 = document.createElement('h3');
          h3.className = 'sub-section-title';
          h3.style.marginBottom = '0';
          h3.textContent = '🎼 ' + g.title;
          var moreBtn = document.createElement('button');
          moreBtn.className = 'btn btn-secondary focusable';
          moreBtn.textContent = 'Xem thêm →';
          moreBtn.addEventListener('click', function () { openHubDetail(g); });
          head.appendChild(h3);
          head.appendChild(moreBtn);

          var row = document.createElement('div');
          row.className = 'playlist-row';
          g.playlists.forEach(function (pl) { row.appendChild(createPlaylistCard(pl)); });

          sec.appendChild(head);
          sec.appendChild(row);
          gBox.appendChild(sec);
        });
      })
      .catch(function () {
        st.textContent = 'Không tải được mục Chủ đề & Thể loại.';
        st.classList.remove('hidden');
      });
  }

  function openHubDetail(topic) {
    state.hubDetailOpen = true;
    $('hub-home-pane').classList.add('hidden');
    $('hub-detail-pane').classList.remove('hidden');
    $('hub-detail-title').textContent = '🎨 ' + (topic.title || 'Chủ đề');
    $('hub-detail-content').innerHTML = '';
    var st = $('hub-detail-status');
    st.textContent = 'Đang tải danh sách nhạc chủ đề "' + (topic.title || '') + '"...';
    st.classList.remove('hidden');
    setFocus($('hub-back-btn'));

    fetch(getApiBase() + '/api/hub-detail?id=' + encodeURIComponent(topic.id))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        st.classList.add('hidden');
        var box = $('hub-detail-content');
        box.innerHTML = '';

        var songs = (data && Array.isArray(data.songs)) ? data.songs : [];
        if (songs.length) {
          var sSec = document.createElement('div');
          sSec.className = 'section-block';
          var sh = document.createElement('h3');
          sh.className = 'sub-section-title';
          sh.textContent = '🎵 Bài hát nổi bật';
          var sg = document.createElement('div');
          sg.className = 'song-grid';
          for (var s = 0; s < songs.length; s++) {
            sg.appendChild(createSongCard(songs[s], songs, s));
          }
          sSec.appendChild(sh);
          sSec.appendChild(sg);
          box.appendChild(sSec);
        }

        var sections = (data && Array.isArray(data.playlistSections)) ? data.playlistSections : [];
        sections.forEach(function (sec) {
          var block = document.createElement('div');
          block.className = 'section-block';
          var h3 = document.createElement('h3');
          h3.className = 'sub-section-title';
          h3.textContent = '💿 ' + sec.title;
          var grid = document.createElement('div');
          grid.className = 'playlist-grid';
          (sec.items || []).forEach(function (pl) { grid.appendChild(createPlaylistCard(pl)); });
          block.appendChild(h3);
          block.appendChild(grid);
          box.appendChild(block);
        });

        if (!songs.length && !sections.length) {
          st.textContent = 'Chủ đề này chưa có nội dung.';
          st.classList.remove('hidden');
        }
      })
      .catch(function () {
        st.textContent = 'Lỗi kết nối khi tải chủ đề.';
        st.classList.remove('hidden');
      });
  }

  function closeHubDetail() {
    state.hubDetailOpen = false;
    $('hub-detail-pane').classList.add('hidden');
    $('hub-home-pane').classList.remove('hidden');
  }

  function performSearch(keyword) {
    keyword = (keyword || '').trim();
    if (!keyword) {
      $('search-status').textContent = 'Vui lòng nhập tên bài hát hoặc ca sĩ.';
      return;
    }
    $('search-input').value = keyword;
    $('search-status').textContent = 'Đang tìm "' + keyword + '" trên Zing MP3...';
    $('search-songs-wrap').classList.add('hidden');
    $('search-playlists-wrap').classList.add('hidden');

    fetch(getApiBase() + '/api/search?q=' + encodeURIComponent(keyword))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var songs = (data && Array.isArray(data.songs)) ? data.songs : [];
        var playlists = (data && Array.isArray(data.playlists)) ? data.playlists : [];

        if (!songs.length && !playlists.length) {
          $('search-status').textContent = 'Không tìm thấy kết quả nào cho "' + keyword + '".';
          return;
        }
        $('search-status').textContent = 'Tìm thấy ' + songs.length + ' bài hát và ' + playlists.length + ' playlist cho "' + keyword + '"';

        if (songs.length > 0) {
          var sBox = $('search-songs');
          sBox.innerHTML = '';
          for (var i = 0; i < songs.length; i++) {
            sBox.appendChild(createSongCard(songs[i], songs, i));
          }
          $('search-songs-wrap').classList.remove('hidden');
        }
        if (playlists.length > 0) {
          var pBox = $('search-playlists');
          pBox.innerHTML = '';
          for (var j = 0; j < playlists.length; j++) {
            pBox.appendChild(createPlaylistCard(playlists[j]));
          }
          $('search-playlists-wrap').classList.remove('hidden');
        }
      })
      .catch(function () {
        $('search-status').textContent = 'Lỗi kết nối khi tìm kiếm.';
      });
  }

  function renderLibrary(tabKey) {
    if (tabKey) state.libraryTab = tabKey;
    updateSubTabs('library-tabs', 'data-lib', state.libraryTab);
    var list = readList(state.libraryTab === 'recent' ? STORAGE_KEYS.RECENT : STORAGE_KEYS.FAVS);
    var grid = $('grid-library');
    var empty = $('library-empty');
    grid.innerHTML = '';
    if (!list.length) {
      empty.textContent = state.libraryTab === 'recent'
        ? 'Bạn chưa nghe bài hát nào gần đây.'
        : 'Chưa có bài hát yêu thích nào. Hãy bấm ❤️ khi nghe nhạc để lưu lại!';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    for (var i = 0; i < list.length; i++) {
      grid.appendChild(createSongCard(list[i], list, i));
    }
  }

  // ===== PLAYLIST OVERLAY =====
  function openPlaylist(pl) {
    state.currentPlaylist = pl;
    $('pl-cover').src = pl.thumbnail || 'icon.png';
    $('pl-title').textContent = pl.title || 'Playlist';
    $('pl-artists').textContent = pl.subtitle || '';
    $('pl-desc').textContent = 'Đang tải danh sách bài hát...';
    $('pl-song-list').innerHTML = '';
    $('pl-status').textContent = 'Đang tải danh sách bài hát từ Zing MP3...';
    $('pl-status').classList.remove('hidden');
    $('playlist-overlay').classList.remove('hidden');
    setFocus($('pl-close-btn'));

    fetch(getApiBase() + '/api/playlist?id=' + encodeURIComponent(pl.id))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !Array.isArray(data.songs)) {
          $('pl-status').textContent = 'Không tải được danh sách bài hát.';
          return;
        }
        state.currentPlaylist = data;
        $('pl-title').textContent = data.title || pl.title;
        $('pl-artists').textContent = data.artists || '';
        $('pl-desc').textContent = data.description || '';
        $('pl-status').classList.add('hidden');

        var listEl = $('pl-song-list');
        listEl.innerHTML = '';
        for (var i = 0; i < data.songs.length; i++) {
          listEl.appendChild(createSongCard(data.songs[i], data.songs, i));
        }
        if (data.songs.length > 0) setFocus($('pl-play-all-btn'));
      })
      .catch(function () {
        $('pl-status').textContent = 'Lỗi kết nối khi tải playlist.';
      });
  }

  function closePlaylist() {
    $('playlist-overlay').classList.add('hidden');
    focusFirstInActiveScope();
  }

  // ===== AUDIO PLAYER & SYNCED LYRICS =====
  function playFirstFreeInList(list) {
    if (!list || !list.length) return;
    var idx = 0;
    for (var i = 0; i < list.length; i++) {
      if (!list[i].isVip) { idx = i; break; }
    }
    playFromList(list, idx, true);
  }

  function playFromList(list, startIdx, openNowPlaying) {
    if (!Array.isArray(list) || !list.length) return;
    state.queue = list.slice();
    state.queueIdx = Math.max(0, Math.min(list.length - 1, startIdx || 0));
    state.skipCount = 0;
    if (openNowPlaying) openNowPlayingOverlay();
    loadCurrentQueueSong();
  }

  function loadCurrentQueueSong() {
    var song = state.queue[state.queueIdx];
    if (!song) return;
    state.currentSong = song;
    state.lyrics = [];
    state.activeLyricIdx = -1;

    updateNowPlayingMeta(song);
    highlightActiveSongs();
    renderQueuePanel();
    renderAmbientAlbumList();
    $('lyrics-list').innerHTML = '<div class="lyric-placeholder">🎵 Đang tải nhạc và lời bài hát...</div>';
    if ($('ambient-lyrics-list')) {
      $('ambient-lyrics-list').innerHTML = '<div class="amb-lyric-empty">🎵 Đang tải lời bài hát...</div>';
    }

    fetch(getApiBase() + '/api/song?id=' + encodeURIComponent(song.id))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!state.currentSong || state.currentSong.id !== song.id) return;

        if (!data || !data.playable || !data.audioUrl) {
          var reason = data && data.vipOnly
            ? ('Bài "' + song.title + '" yêu cầu VIP Zing MP3 — tự chuyển bài tiếp theo...')
            : ('Không phát được "' + song.title + '" — chuyển bài tiếp theo...');
          showToast(reason, 2600);
          state.skipCount += 1;
          if (state.skipCount < Math.min(state.queue.length, 6)) {
            playNextSong(true);
          } else {
            $('lyrics-list').innerHTML = '<div class="lyric-placeholder">Các bài trong danh sách này hiện đang yêu cầu tài khoản VIP Zing MP3.</div>';
          }
          return;
        }

        state.skipCount = 0;
        addToRecent(song);
        $('now-quality-pill').textContent = '🎵 Zing MP3 • ' + (data.quality || '128kbps');

        state.lyrics = Array.isArray(data.lyrics) ? data.lyrics : [];
        renderLyricsList();

        var audio = $('tv-audio');
        audio.src = data.audioUrl;
        audio.play().catch(function (err) {
          sendClientLog('AUDIO-PLAY-ERR', err && err.message ? err.message : String(err));
        });
      })
      .catch(function (err) {
        sendClientLog('SONG-FETCH-ERR', err.message || String(err));
        showToast('Lỗi khi tải luồng nhạc.');
      });
  }

  function updateNowPlayingMeta(song) {
    var thumb = song.thumbnail || 'icon.png';
    $('mini-cover').src = thumb;
    $('mini-title').textContent = song.title || 'Zing MP3';
    $('mini-artist').textContent = song.artists || '';

    $('now-cover').src = thumb;
    $('now-title').textContent = song.title || 'Zing MP3';
    $('now-artist').textContent = song.artists || '';
    $('now-bg-blur').style.backgroundImage = thumb ? ('url("' + thumb + '")') : '';

    if ($('ambient-cover')) $('ambient-cover').src = thumb;
    if ($('ambient-title')) $('ambient-title').textContent = song.title || 'Zing MP3 TV';
    if ($('ambient-artist')) $('ambient-artist').textContent = song.artists || '';
    if ($('ambient-album-bg')) $('ambient-album-bg').style.backgroundImage = thumb ? ('url("' + thumb + '")') : '';
    if ($('ambient-lyric-line')) $('ambient-lyric-line').textContent = '';

    updateFavButtons();
  }

  function renderLyricsList() {
    var box = $('lyrics-list');
    var ambBox = $('ambient-lyrics-list');
    box.innerHTML = '';
    if (ambBox) ambBox.innerHTML = '';

    if (!state.lyrics.length) {
      box.innerHTML = '<div class="lyric-placeholder">Bài hát này chưa có lời đồng bộ.<br>Chúc bạn nghe nhạc thư giãn! 🎧</div>';
      if (ambBox) ambBox.innerHTML = '<div class="amb-lyric-empty">Bài hát này chưa có lời đồng bộ 🎧</div>';
      return;
    }
    for (var i = 0; i < state.lyrics.length; i++) {
      var div = document.createElement('div');
      div.className = 'lyric-line';
      div.setAttribute('data-lidx', String(i));
      div.textContent = state.lyrics[i].text;
      box.appendChild(div);

      if (ambBox) {
        var adiv = document.createElement('div');
        adiv.className = 'amb-lyric-item';
        adiv.textContent = state.lyrics[i].text;
        ambBox.appendChild(adiv);
      }
    }
  }

  function syncLyricsToTime(curSec) {
    if (!state.lyrics.length) return;
    var found = -1;
    for (var i = 0; i < state.lyrics.length; i++) {
      if (curSec + 0.15 >= state.lyrics[i].time) found = i;
      else break;
    }
    if (found === state.activeLyricIdx) return;
    state.activeLyricIdx = found;

    var lines = $('lyrics-list').querySelectorAll('.lyric-line');
    for (var j = 0; j < lines.length; j++) {
      lines[j].classList.remove('active', 'past');
      if (j < found) lines[j].classList.add('past');
      else if (j === found) lines[j].classList.add('active');
    }
    if (found >= 0 && lines[found]) {
      try {
        lines[found].scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {}
    }

    var ambBox = $('ambient-lyrics-list');
    if (ambBox) {
      var aLines = ambBox.querySelectorAll('.amb-lyric-item');
      for (var k = 0; k < aLines.length; k++) {
        aLines[k].classList.toggle('active', k === found);
      }
      if (found >= 0 && aLines[found] && state.ambientOpen) {
        try {
          aLines[found].scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (e) {}
      }
    }
  }

  function renderAmbientAlbumList() {
    var box = $('ambient-album-list');
    if (!box) return;
    box.innerHTML = '';

    var list = state.queue || [];
    if ($('ambient-album-heading')) {
      var albumTitle = (state.currentPlaylist && state.currentPlaylist.title)
        ? ('💿 ' + state.currentPlaylist.title)
        : (state.currentSong && state.currentSong.album ? ('💿 ' + state.currentSong.album) : '💿 Danh sách phát');
      $('ambient-album-heading').textContent = albumTitle;
    }
    if ($('ambient-album-count')) {
      $('ambient-album-count').textContent = list.length + ' bài';
    }

    if (!list.length) {
      box.innerHTML = '<div class="amb-lyric-empty">Chưa có danh sách bài hát.</div>';
      return;
    }

    var curId = state.currentSong ? state.currentSong.id : '';
    for (var i = 0; i < list.length; i++) {
      (function (song, idx) {
        var btn = document.createElement('button');
        var isCur = Boolean(curId) && song.id === curId;
        btn.className = 'amb-song-row focusable' + (isCur ? ' playing' : '');
        btn.innerHTML =
          '<span class="amb-song-num">' + (isCur ? '▶' : String(idx + 1)) + '</span>' +
          '<div class="amb-song-text">' +
            '<div class="amb-song-name">' + escapeHtml(song.title) + '</div>' +
            '<div class="amb-song-art">' + escapeHtml(song.artists) + '</div>' +
          '</div>';
        btn.addEventListener('click', function () {
          state.queueIdx = idx;
          state.skipCount = 0;
          loadCurrentQueueSong();
        });
        box.appendChild(btn);
      })(list[i], i);
    }

    var activeRow = box.querySelector('.amb-song-row.playing');
    if (activeRow && state.ambientOpen) {
      try { activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
    }
  }

  function renderQueuePanel() {
    var box = $('queue-list');
    box.innerHTML = '';
    for (var i = 0; i < state.queue.length; i++) {
      (function (song, idx) {
        var btn = createSongCard(song, state.queue, idx);
        btn.onclick = null;
        box.appendChild(btn);
      })(state.queue[i], i);
    }
  }

  function setNowRightTab(tab) {
    state.nowRightTab = tab;
    $('now-tab-lyrics').classList.toggle('active', tab === 'lyrics');
    $('now-tab-queue').classList.toggle('active', tab === 'queue');
    $('now-lyrics-panel').classList.toggle('hidden', tab !== 'lyrics');
    $('now-queue-panel').classList.toggle('hidden', tab !== 'queue');
  }

  function openNowPlayingOverlay() {
    $('player-overlay').classList.remove('hidden');
    setFocus($('now-play-btn'));
  }

  function closeNowPlayingOverlay() {
    $('player-overlay').classList.add('hidden');
    focusFirstInActiveScope();
  }

  function togglePlayPause() {
    var audio = $('tv-audio');
    if (!state.currentSong) {
      loadChartData(true);
      return;
    }
    if (audio.paused) audio.play().catch(function () {});
    else audio.pause();
  }

  function playNextSong(isAutoSkip) {
    if (!state.queue.length) return;
    if (state.repeat && !isAutoSkip) {
      var audio = $('tv-audio');
      audio.currentTime = 0;
      audio.play().catch(function () {});
      return;
    }
    if (state.shuffle && state.queue.length > 1) {
      var next = state.queueIdx;
      while (next === state.queueIdx) {
        next = Math.floor(Math.random() * state.queue.length);
      }
      state.queueIdx = next;
    } else {
      state.queueIdx = (state.queueIdx + 1) % state.queue.length;
    }
    loadCurrentQueueSong();
  }

  function playPrevSong() {
    if (!state.queue.length) return;
    var audio = $('tv-audio');
    if (audio.currentTime > 4) {
      audio.currentTime = 0;
      return;
    }
    state.queueIdx = (state.queueIdx - 1 + state.queue.length) % state.queue.length;
    loadCurrentQueueSong();
  }

  function seekBy(sec) {
    var audio = $('tv-audio');
    if (!isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration - 0.5, audio.currentTime + sec));
    showToast((sec >= 0 ? '⏩ +' : '⏪ ') + sec + 's (' + formatTime(audio.currentTime) + ')', 1400);
  }

  function updatePlayIcons(isPlaying) {
    var txt = isPlaying ? '⏸' : '▶';
    $('mini-play-btn').textContent = txt;
    $('now-play-btn').textContent = txt;
    if ($('amb-play-btn')) $('amb-play-btn').textContent = txt;
    $('mini-cover').classList.toggle('spinning', isPlaying);
    if ($('ambient-cover')) $('ambient-cover').classList.toggle('spinning', isPlaying);
    $('sidebar-eq').classList.toggle('playing', isPlaying);
  }

  // ===== AMBIENT FULL SCREEN (RANDOM GIF + BIÊN HÒA WEATHER + CALENDAR + MUSIC VISUALIZER) =====
  var VN_WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

  function renderAmbientCalendar(now) {
    var y = now.getFullYear();
    var m = now.getMonth();
    var today = now.getDate();
    var monthKey = y + '-' + m + '-' + today;
    if (state.ambientCalMonthKey === monthKey) return;
    state.ambientCalMonthKey = monthKey;

    var grid = $('ambient-calendar-grid');
    if (!grid) return;
    grid.innerHTML = '';

    var firstDow = new Date(y, m, 1).getDay(); // 0=Sun..6=Sat
    var offset = (firstDow === 0) ? 6 : (firstDow - 1); // Monday-first
    var daysInMonth = new Date(y, m + 1, 0).getDate();

    for (var e = 0; e < offset; e++) {
      var blank = document.createElement('div');
      blank.className = 'cal-day empty';
      blank.textContent = '.';
      grid.appendChild(blank);
    }

    for (var d = 1; d <= daysInMonth; d++) {
      var cell = document.createElement('div');
      var dow = new Date(y, m, d).getDay();
      var cls = 'cal-day';
      if (dow === 0) cls += ' sun';
      if (d === today) cls += ' today';
      cell.className = cls;
      cell.textContent = String(d);
      grid.appendChild(cell);
    }
  }

  function updateAmbientClock() {
    var now = new Date();
    var hh = now.getHours();
    var mm = now.getMinutes();
    var ss = now.getSeconds();
    if ($('ambient-clock')) {
      $('ambient-clock').textContent = (hh < 10 ? '0' + hh : '' + hh) + ':' + (mm < 10 ? '0' + mm : '' + mm);
    }
    if ($('ambient-sec')) {
      $('ambient-sec').textContent = ':' + (ss < 10 ? '0' + ss : '' + ss);
    }
    if ($('ambient-date-text')) {
      var dayStr = VN_WEEKDAYS[now.getDay()];
      var dd = now.getDate();
      var mo = now.getMonth() + 1;
      $('ambient-date-text').textContent = dayStr + ', ' + (dd < 10 ? '0' + dd : dd) + ' Tháng ' + (mo < 10 ? '0' + mo : mo) + ', ' + now.getFullYear();
    }
    renderAmbientCalendar(now);
  }

  function loadAmbientWeather() {
    fetch(getApiBase() + '/api/weather')
      .then(function (r) { return r.json(); })
      .then(function (w) {
        if (!w || w.error) return;
        if ($('weather-icon')) $('weather-icon').textContent = w.icon || '🌤️';
        if ($('weather-temp')) $('weather-temp').textContent = (w.temp !== null ? w.temp + '°C' : '--°C');
        if ($('weather-desc')) $('weather-desc').textContent = w.desc || '';
        if ($('weather-minmax')) {
          $('weather-minmax').textContent = (w.tempMax !== null ? w.tempMax : '--') + '° / ' + (w.tempMin !== null ? w.tempMin : '--') + '°';
        }
        if ($('weather-humidity')) $('weather-humidity').textContent = (w.humidity !== null ? w.humidity + '%' : '--%');
        if ($('weather-rain')) $('weather-rain').textContent = (w.rainChance !== null ? w.rainChance + '%' : '--%');
        if ($('weather-wind')) $('weather-wind').textContent = (w.wind !== null ? w.wind + ' km/h' : '-- km/h');
      })
      .catch(function () {});
  }

  var AMBIENT_TOPICS = [
    { id: 'rainy', label: '🌧️ Rainy' },
    { id: 'lofi', label: '🎧 Lofi' },
    { id: 'study', label: '📚 Study' },
    { id: 'cozy', label: '☕ Cozy' },
    { id: 'local', label: '🌿 Ghibli' }
  ];

  function getAmbientTopicLabel(id) {
    for (var i = 0; i < AMBIENT_TOPICS.length; i++) {
      if (AMBIENT_TOPICS[i].id === id) return AMBIENT_TOPICS[i].label;
    }
    return '🌧️ Rainy';
  }

  function updateAmbientTopicBtn() {
    var btn = $('amb-topic-btn');
    if (!btn) return;
    btn.textContent = getAmbientTopicLabel(state.ambientTopic);
  }

  function cycleAmbientTopic() {
    var cur = 0;
    for (var i = 0; i < AMBIENT_TOPICS.length; i++) {
      if (AMBIENT_TOPICS[i].id === state.ambientTopic) { cur = i; break; }
    }
    var next = AMBIENT_TOPICS[(cur + 1) % AMBIENT_TOPICS.length];
    state.ambientTopic = next.id;
    state.ambientGifIdx = -1;
    updateAmbientTopicBtn();
    showToast('🎨 Nền Full Screen: ' + next.label, 1800);
    loadAmbientGifs(true);
  }

  function loadAmbientGifs(triggerShow) {
    updateAmbientTopicBtn();
    var reqId = ++state.ambientReqId;
    var reqTopic = state.ambientTopic;
    fetch(getApiBase() + '/api/ambient-media?topic=' + encodeURIComponent(reqTopic))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (reqId !== state.ambientReqId) return;
        state.ambientSource = (data && data.source) || 'local';
        state.ambientGifs = (data && Array.isArray(data.items)) ? data.items : [];
        if (data && data.fallbackReason === 'rate_limit') {
          showToast('API hình nền HD tạm hết lượt gọi — tự động chuyển sang thư viện ảnh Ghibli!', 2800);
        }
        if (state.ambientGifs.length > 0 && triggerShow) {
          showNextRandomGif(false);
        }
      })
      .catch(function () {
        if (reqId !== state.ambientReqId) return;
        fetch(getApiBase() + '/api/ambient-gifs')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (reqId !== state.ambientReqId) return;
            state.ambientSource = 'local';
            state.ambientGifs = (d && Array.isArray(d.gifs)) ? d.gifs : [];
            if (state.ambientGifs.length > 0 && triggerShow) showNextRandomGif(false);
          })
          .catch(function () {});
      });
  }

  function clearAmbientImages() {
    var imgA = $('ambient-gif-a');
    var imgB = $('ambient-gif-b');
    if (imgA) {
      imgA.classList.remove('visible');
      imgA.removeAttribute('src');
    }
    if (imgB) {
      imgB.classList.remove('visible');
      imgB.removeAttribute('src');
    }
  }

  function showNextRandomGif(userClicked) {
    var list = state.ambientGifs;
    if (!list || !list.length) {
      if (userClicked) {
        showToast('Đang tải thư viện hình nền...', 2000);
        loadAmbientGifs(true);
      }
      if ($('ambient-gif-a')) $('ambient-gif-a').classList.remove('visible');
      if ($('ambient-gif-b')) $('ambient-gif-b').classList.remove('visible');
      return;
    }

    var nextIdx = 0;
    if (list.length > 1) {
      nextIdx = state.ambientGifIdx;
      while (nextIdx === state.ambientGifIdx) {
        nextIdx = Math.floor(Math.random() * list.length);
      }
    }
    state.ambientGifIdx = nextIdx;
    var chosen = list[nextIdx];

    // Crossfade animated GIPHY WebP/GIF or local Ghibli static wallpaper via <img>
    // (100% immune to webOS uMediaServer <video>/<audio> hardware slot conflict!)
    var showSlot = state.ambientGifSlot === 'a' ? 'b' : 'a';
    var hideSlot = state.ambientGifSlot;
    state.ambientGifSlot = showSlot;

    var imgShow = $('ambient-gif-' + showSlot);
    var imgHide = $('ambient-gif-' + hideSlot);
    if (!imgShow) return;

    var targetUrl = chosen.url;
    imgShow.onload = function () {
      if (!state.ambientOpen) return;
      imgShow.classList.add('visible');
      if (imgHide) imgHide.classList.remove('visible');
    };
    imgShow.onerror = function () {
      if (!state.ambientOpen) return;
      sendClientLog('AMBIENT-IMG-ERR', targetUrl);
      if (state.ambientTopic !== 'local') {
        state.ambientTopic = 'local';
        state.ambientGifIdx = -1;
        loadAmbientGifs(true);
      }
    };
    imgShow.src = targetUrl;
  }

  function initAudioVisualizer() {
    var audio = $('tv-audio');
    if (!audio) return;
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    if (!state.audioCtx) {
      try {
        var ctx = new AudioCtx();
        var src = ctx.createMediaElementSource(audio);
        var analyser = ctx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.8;
        src.connect(analyser);
        analyser.connect(ctx.destination);

        state.audioCtx = ctx;
        state.audioSource = src;
        state.analyser = analyser;
        state.vizData = new Uint8Array(analyser.frequencyBinCount);
      } catch (e) {
        sendClientLog('VIZ-INIT-ERR', e && e.message ? e.message : String(e));
      }
    }

    if (state.audioCtx && state.audioCtx.state === 'suspended') {
      try { state.audioCtx.resume(); } catch (e) {}
    }
  }

  function startVisualizerLoop() {
    stopVisualizerLoop();
    var canvas = $('ambient-visualizer');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Lightweight TV-optimized neon cyan-white circular equalizer (~30fps cap, zero heavy shadowBlur)
    var barCount = 84;
    if (!state.vizPeaks || state.vizPeaks.length !== barCount) {
      state.vizPeaks = [];
      for (var p = 0; p < barCount; p++) state.vizPeaks.push(0);
    }

    // Fixed zero-allocation particle pool (40 glowing cyan sparks)
    var maxParticles = 40;
    var particles = [];
    for (var pi = 0; pi < maxParticles; pi++) {
      particles.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, r: 1.5 });
    }
    var pCursor = 0;

    function spawnSpark(x, y, angle, speed) {
      var pt = particles[pCursor];
      pCursor = (pCursor + 1) % maxParticles;
      pt.active = true;
      pt.x = x;
      pt.y = y;
      var spread = angle + (Math.random() - 0.5) * 0.5;
      pt.vx = Math.cos(spread) * speed;
      pt.vy = Math.sin(spread) * speed;
      pt.life = 0;
      pt.maxLife = 22 + Math.floor(Math.random() * 20);
      pt.r = 1.2 + Math.random() * 1.8;
    }

    var audio = $('tv-audio');
    var framePhase = 0;
    var smoothBass = 0;
    var lastDrawTime = 0;
    var size = 420;
    canvas.width = size;
    canvas.height = size;
    var cx = size / 2;
    var cy = size / 2;

    function drawFrame() {
      if (!state.ambientOpen) return;
      state.vizRafId = window.requestAnimationFrame(drawFrame);

      // Throttle to ~30fps using a single consistent clock (Date.now) so it NEVER freezes
      var now = Date.now();
      if (lastDrawTime && (now - lastDrawTime) < 32) return;
      lastDrawTime = now;

      state.vizFrameCount = (state.vizFrameCount || 0) + 1;
      ctx.clearRect(0, 0, size, size);

      var isPlaying = Boolean(audio && !audio.paused && !audio.ended);
      framePhase += isPlaying ? 0.085 : 0.032;

      if (isPlaying && state.audioCtx && state.audioCtx.state === 'suspended') {
        try { state.audioCtx.resume(); } catch (e) {}
      }

      var hasLiveAudio = false;
      var bassAvg = 0;
      if (state.analyser && state.vizData && isPlaying) {
        state.analyser.getByteFrequencyData(state.vizData);
        for (var s = 0; s < state.vizData.length; s++) {
          if (state.vizData[s] > 2) { hasLiveAudio = true; break; }
        }
        if (hasLiveAudio) {
          var bassSum = 0;
          var bassBins = Math.min(8, state.vizData.length);
          for (var b = 0; b < bassBins; b++) bassSum += state.vizData[b];
          bassAvg = (bassSum / bassBins) / 255;
        }
      }

      var playTime = isPlaying && audio ? (audio.currentTime || 0) : 0;
      if (!hasLiveAudio) {
        if (isPlaying) {
          // Energetic musical beat pulse fallback if TV hardware audio bypasses WebAudio Analyser
          var beat1 = Math.pow(Math.abs(Math.sin(playTime * 3.14159 * 2.05)), 2.2);
          var beat2 = Math.pow(Math.abs(Math.sin(playTime * 3.14159 * 1.02 + 0.7)), 3);
          bassAvg = 0.25 + beat1 * 0.45 + beat2 * 0.22;
        } else {
          bassAvg = (Math.sin(framePhase * 1.2) * 0.5 + 0.5) * 0.14;
        }
      }
      smoothBass = smoothBass * 0.68 + bassAvg * 0.32;

      var baseR = 96 + smoothBass * 22;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // 1. Soft electric cyan atmospheric halo around the ring (1 cheap radial gradient)
      var haloGrad = ctx.createRadialGradient(cx, cy, baseR * 0.72, cx, cy, baseR + 92);
      haloGrad.addColorStop(0, 'rgba(0, 140, 255, 0)');
      haloGrad.addColorStop(0.42, 'rgba(0, 210, 255, ' + (0.28 + smoothBass * 0.24).toFixed(2) + ')');
      haloGrad.addColorStop(0.68, 'rgba(56, 189, 248, ' + (0.16 + smoothBass * 0.14).toFixed(2) + ')');
      haloGrad.addColorStop(1, 'rgba(0, 120, 255, 0)');
      ctx.fillStyle = haloGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR + 92, 0, Math.PI * 2);
      ctx.fill();

      // 2. Smooth flowing electric cyan plasma ribbons hugging the outer spectrum
      for (var wLayer = 0; wLayer < 2; wLayer++) {
        ctx.beginPath();
        var waveSteps = 48;
        for (var wi = 0; wi <= waveSteps; wi++) {
          var wa = (wi / waveSteps) * Math.PI * 2 - Math.PI / 2;
          var binW = Math.floor((wi % 24) / 24 * (state.vizData ? state.vizData.length * 0.65 : 16));
          var ampW = hasLiveAudio && state.vizData
            ? (state.vizData[binW] / 255)
            : (isPlaying
              ? (0.28 + Math.sin(playTime * 6.2 + wi * 0.65) * 0.22 + smoothBass * 0.25)
              : (0.14 + Math.sin(framePhase + wi * 0.5) * 0.08));
          var ripple = Math.sin(wa * (wLayer === 0 ? 5 : 7) + framePhase * (wLayer === 0 ? 1.8 : -2.3)) * (10 + smoothBass * 18);
          var wr = baseR + 12 + ampW * (34 + wLayer * 14) + ripple;
          var wx = cx + Math.cos(wa) * wr;
          var wy = cy + Math.sin(wa) * wr;
          if (wi === 0) ctx.moveTo(wx, wy);
          else ctx.lineTo(wx, wy);
        }
        ctx.closePath();
        ctx.strokeStyle = wLayer === 0 ? 'rgba(56, 232, 255, 0.42)' : 'rgba(125, 249, 255, 0.25)';
        ctx.lineWidth = wLayer === 0 ? 2.2 : 1.4;
        ctx.stroke();
      }

      // 3. 84 crisp white-cyan radial equalizer bars pulsing outward from the ring
      for (var i = 0; i < barCount; i++) {
        var angle = (i / barCount) * Math.PI * 2 - Math.PI * 0.62;
        var norm = 0;
        if (hasLiveAudio) {
          var half = i < barCount / 2 ? i : (barCount - 1 - i);
          var binIdx = Math.min(state.vizData.length - 1, Math.floor((half / (barCount / 2)) * (state.vizData.length * 0.78)));
          norm = state.vizData[binIdx] / 255;
        } else if (isPlaying) {
          var sym = i < barCount / 2 ? i : (barCount - 1 - i);
          var w1 = Math.sin(playTime * 7.8 + sym * 0.38) * 0.5 + 0.5;
          var w2 = Math.cos(playTime * 4.3 - sym * 0.22) * 0.5 + 0.5;
          var w3 = Math.sin(playTime * 11.4 + sym * 0.71) * 0.5 + 0.5;
          norm = Math.min(1, (w1 * 0.42 + w2 * 0.35 + w3 * 0.23) * (0.55 + smoothBass * 0.75));
        } else {
          norm = (Math.sin(framePhase * 1.5 + i * 0.28) * 0.5 + 0.5) * 0.14 + 0.04;
        }

        // Smooth decay so peaks fall gently like real audio meters
        var targetLen = 4 + Math.pow(norm, 1.25) * 68;
        state.vizPeaks[i] = targetLen > state.vizPeaks[i] ? targetLen : (state.vizPeaks[i] * 0.84 + targetLen * 0.16);
        var barLen = state.vizPeaks[i];

        var x1 = cx + Math.cos(angle) * (baseR + 3);
        var y1 = cy + Math.sin(angle) * (baseR + 3);
        var x2 = cx + Math.cos(angle) * (baseR + 3 + barLen);
        var y2 = cy + Math.sin(angle) * (baseR + 3 + barLen);

        // Soft cyan outer bar glow
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.55)';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Hot white-ice inner bar core
        ctx.strokeStyle = 'rgba(235, 252, 255, 0.95)';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Emit subtle glowing spark particles from high energy peaks
        if (barLen > 34 && Math.random() < 0.16) {
          spawnSpark(x2, y2, angle, 0.9 + norm * 2.1);
        }
      }

      // 4. Update & draw lightweight glowing cyan/white particle embers
      for (var k = 0; k < maxParticles; k++) {
        var pt = particles[k];
        if (!pt.active) continue;
        pt.life += 1;
        if (pt.life >= pt.maxLife) { pt.active = false; continue; }
        pt.x += pt.vx;
        pt.y += pt.vy;
        pt.vx *= 0.97;
        pt.vy *= 0.97;
        var alpha = (1 - pt.life / pt.maxLife) * 0.85;
        ctx.fillStyle = 'rgba(165, 243, 252, ' + alpha.toFixed(2) + ')';
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, pt.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 5. Razor-bright white-hot neon core ring + cyan outer bloom + warm-white flare arc
      ctx.strokeStyle = 'rgba(0, 215, 255, 0.55)';
      ctx.lineWidth = 10 + smoothBass * 4;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(255, 240, 250, 0.96)';
      ctx.lineWidth = 4 + smoothBass * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
      ctx.stroke();

      // Bright energetic comet arc gliding around the ring edge (matches reference glow flare)
      var arcStart = framePhase * 0.45 - 0.3;
      var arcEnd = arcStart + 0.95 + smoothBass * 0.4;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 7 + smoothBass * 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, baseR + 1, arcStart, arcEnd);
      ctx.stroke();

      ctx.restore();
    }

    state.vizFrameCount = 0;
    drawFrame();
  }

  function stopVisualizerLoop() {
    if (state.vizRafId) {
      try { window.cancelAnimationFrame(state.vizRafId); } catch (e) {}
      state.vizRafId = null;
    }
  }

  function openAmbientFullscreen() {
    state.ambientOpen = true;
    $('ambient-overlay').classList.remove('hidden');
    if (state.currentSong) updateNowPlayingMeta(state.currentSong);
    renderAmbientAlbumList();
    renderLyricsList();
    updateAmbientClock();
    loadAmbientWeather();
    loadAmbientGifs(true);
    initAudioVisualizer();
    startVisualizerLoop();

    clearInterval(state.ambientClockTimer);
    state.ambientClockTimer = setInterval(updateAmbientClock, 1000);

    clearInterval(state.ambientWeatherTimer);
    state.ambientWeatherTimer = setInterval(loadAmbientWeather, 15 * 60 * 1000);

    clearInterval(state.ambientGifTimer);
    state.ambientGifTimer = setInterval(function () {
      if (state.ambientOpen && state.ambientGifs.length > 1) {
        showNextRandomGif(false);
      }
    }, 25000);

    setFocus($('amb-play-btn'));
  }

  function closeAmbientFullscreen() {
    state.ambientOpen = false;
    $('ambient-overlay').classList.add('hidden');
    clearInterval(state.ambientClockTimer);
    clearInterval(state.ambientWeatherTimer);
    clearInterval(state.ambientGifTimer);
    stopVisualizerLoop();
    clearAmbientImages();
    focusFirstInActiveScope();
  }

  // ===== SPATIAL TV D-PAD NAVIGATION =====
  function getActiveScopeElement() {
    if (!$('ambient-overlay').classList.contains('hidden')) return $('ambient-overlay');
    if (!$('player-overlay').classList.contains('hidden')) return $('player-overlay');
    if (!$('playlist-overlay').classList.contains('hidden')) return $('playlist-overlay');
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
      var pDist = 0;
      var sDist = 0;

      if (direction === 'right' && dx > 10) { isValid = true; pDist = dx; sDist = Math.abs(dy); }
      else if (direction === 'left' && dx < -10) { isValid = true; pDist = -dx; sDist = Math.abs(dy); }
      else if (direction === 'down' && dy > 10) { isValid = true; pDist = dy; sDist = Math.abs(dx); }
      else if (direction === 'up' && dy < -10) { isValid = true; pDist = -dy; sDist = Math.abs(dx); }

      if (isValid) {
        var score = pDist + sDist * 2.5;
        if (score < bestScore) { bestScore = score; bestEl = cand; }
      }
    }
    if (bestEl) setFocus(bestEl);
  }

  function handleBackKey() {
    if (!$('ambient-overlay').classList.contains('hidden')) { closeAmbientFullscreen(); return; }
    if (!$('player-overlay').classList.contains('hidden')) { closeNowPlayingOverlay(); return; }
    if (!$('playlist-overlay').classList.contains('hidden')) { closePlaylist(); return; }
    if (state.activeView === 'hub' && state.hubDetailOpen) { closeHubDetail(); focusFirstInActiveScope(); return; }
    if (state.activeView !== 'home') { switchView('home'); focusFirstInActiveScope(); return; }
    if (window.webOS && window.webOS.platformBack) window.webOS.platformBack();
  }

  function setupKeyboardAndRemote() {
    document.addEventListener('keydown', function (e) {
      var key = e.key;
      var code = e.keyCode || e.which;
      var isInput = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');

      if (code === 461 || key === 'Escape' || (key === 'Backspace' && !isInput)) {
        e.preventDefault();
        handleBackKey();
        return;
      }

      // LG Magic Remote Media Keys (work from ANY screen!)
      if (code === 415) { e.preventDefault(); $('tv-audio').play().catch(function () {}); return; }
      if (code === 19) { e.preventDefault(); $('tv-audio').pause(); return; }
      if (code === 417) { e.preventDefault(); seekBy(10); return; }
      if (code === 412) { e.preventDefault(); seekBy(-10); return; }
      if (code === 413) { e.preventDefault(); $('tv-audio').pause(); $('tv-audio').currentTime = 0; return; }

      if (isInput) {
        if (key === 'ArrowDown' || code === 40) { e.preventDefault(); moveFocusDirection('down'); }
        else if (key === 'ArrowUp' || code === 38) { e.preventDefault(); moveFocusDirection('up'); }
        else if ((key === 'Enter' || code === 13) && document.activeElement.id === 'search-input') {
          performSearch($('search-input').value);
        }
        return;
      }

      if (key === 'ArrowUp' || key === 'Up' || code === 38) { e.preventDefault(); moveFocusDirection('up'); }
      else if (key === 'ArrowDown' || key === 'Down' || code === 40) { e.preventDefault(); moveFocusDirection('down'); }
      else if (key === 'ArrowLeft' || key === 'Left' || code === 37) { e.preventDefault(); moveFocusDirection('left'); }
      else if (key === 'ArrowRight' || key === 'Right' || code === 39) { e.preventDefault(); moveFocusDirection('right'); }
    });
  }

  function bindEvents() {
    // Sidebar nav
    var navs = document.querySelectorAll('.nav-item');
    for (var i = 0; i < navs.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          switchView(btn.getAttribute('data-nav'));
        });
      })(navs[i]);
    }

    $('sidebar-nowplaying-btn').addEventListener('click', openNowPlayingOverlay);
    $('btn-quick-play-chart').addEventListener('click', function () { loadChartData(true); });
    if ($('hub-back-btn')) $('hub-back-btn').addEventListener('click', closeHubDetail);

    // Home new release sub-tabs
    var nrTabs = document.querySelectorAll('#new-release-tabs .sub-tab');
    for (var n = 0; n < nrTabs.length; n++) {
      (function (btn) {
        btn.addEventListener('click', function () { renderNewReleases(btn.getAttribute('data-nr')); });
      })(nrTabs[n]);
    }

    // Chart sub-tabs
    var chTabs = document.querySelectorAll('#chart-tabs .sub-tab');
    for (var c = 0; c < chTabs.length; c++) {
      (function (btn) {
        btn.addEventListener('click', function () { renderChartTab(btn.getAttribute('data-chart')); });
      })(chTabs[c]);
    }

    // Library sub-tabs
    var libTabs = document.querySelectorAll('#library-tabs .sub-tab');
    for (var l = 0; l < libTabs.length; l++) {
      (function (btn) {
        btn.addEventListener('click', function () { renderLibrary(btn.getAttribute('data-lib')); });
      })(libTabs[l]);
    }

    // Search
    $('search-submit-btn').addEventListener('click', function () { performSearch($('search-input').value); });
    $('search-clear-btn').addEventListener('click', function () {
      $('search-input').value = '';
      $('search-status').textContent = '';
      $('search-songs-wrap').classList.add('hidden');
      $('search-playlists-wrap').classList.add('hidden');
      setFocus($('search-input'));
    });
    var tagBtns = document.querySelectorAll('.tag-btn');
    for (var t = 0; t < tagBtns.length; t++) {
      (function (btn) {
        btn.addEventListener('click', function () { performSearch(btn.getAttribute('data-tag')); });
      })(tagBtns[t]);
    }

    // Playlist overlay
    $('pl-close-btn').addEventListener('click', closePlaylist);
    $('pl-play-all-btn').addEventListener('click', function () {
      if (state.currentPlaylist && Array.isArray(state.currentPlaylist.songs)) {
        closePlaylist();
        playFirstFreeInList(state.currentPlaylist.songs);
      }
    });
    $('pl-shuffle-btn').addEventListener('click', function () {
      if (state.currentPlaylist && Array.isArray(state.currentPlaylist.songs) && state.currentPlaylist.songs.length) {
        state.shuffle = true;
        $('now-shuffle-btn').classList.add('active-toggle');
        var randIdx = Math.floor(Math.random() * state.currentPlaylist.songs.length);
        closePlaylist();
        playFromList(state.currentPlaylist.songs, randIdx, true);
      }
    });

    // Mini player
    $('mini-prev-btn').addEventListener('click', playPrevSong);
    $('mini-play-btn').addEventListener('click', togglePlayPause);
    $('mini-next-btn').addEventListener('click', function () { playNextSong(false); });
    $('mini-fav-btn').addEventListener('click', function () { toggleFavorite(state.currentSong); });
    if ($('mini-ambient-btn')) $('mini-ambient-btn').addEventListener('click', openAmbientFullscreen);
    $('mini-expand-btn').addEventListener('click', openNowPlayingOverlay);

    // Now Playing overlay
    $('now-close-btn').addEventListener('click', closeNowPlayingOverlay);
    if ($('now-ambient-btn')) $('now-ambient-btn').addEventListener('click', openAmbientFullscreen);
    $('now-tab-lyrics').addEventListener('click', function () { setNowRightTab('lyrics'); });
    $('now-tab-queue').addEventListener('click', function () { setNowRightTab('queue'); });

    // Ambient Full Screen overlay
    if ($('amb-prev-btn')) $('amb-prev-btn').addEventListener('click', playPrevSong);
    if ($('amb-play-btn')) $('amb-play-btn').addEventListener('click', togglePlayPause);
    if ($('amb-next-btn')) $('amb-next-btn').addEventListener('click', function () { playNextSong(false); });
    if ($('amb-topic-btn')) $('amb-topic-btn').addEventListener('click', cycleAmbientTopic);
    if ($('amb-gif-btn')) $('amb-gif-btn').addEventListener('click', function () {
      showNextRandomGif(true);
    });
    if ($('amb-close-btn')) $('amb-close-btn').addEventListener('click', closeAmbientFullscreen);
    $('now-prev-btn').addEventListener('click', playPrevSong);
    $('now-play-btn').addEventListener('click', togglePlayPause);
    $('now-next-btn').addEventListener('click', function () { playNextSong(false); });
    $('now-fav-btn').addEventListener('click', function () { toggleFavorite(state.currentSong); });
    $('now-shuffle-btn').addEventListener('click', function () {
      state.shuffle = !state.shuffle;
      $('now-shuffle-btn').classList.toggle('active-toggle', state.shuffle);
      showToast(state.shuffle ? '🔀 Đã bật phát ngẫu nhiên' : '🔀 Đã tắt phát ngẫu nhiên', 1600);
    });
    $('now-repeat-btn').addEventListener('click', function () {
      state.repeat = !state.repeat;
      $('now-repeat-btn').classList.toggle('active-toggle', state.repeat);
      showToast(state.repeat ? '🔁 Đã bật lặp lại bài này' : '🔁 Đã tắt lặp lại', 1600);
    });

    $('now-progress-track').addEventListener('click', function (e) {
      var audio = $('tv-audio');
      if (!isFinite(audio.duration)) return;
      var rect = this.getBoundingClientRect();
      var ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * audio.duration;
    });

    // Audio element events
    var audio = $('tv-audio');
    audio.addEventListener('play', function () {
      initAudioVisualizer();
      updatePlayIcons(true);
    });
    audio.addEventListener('pause', function () { updatePlayIcons(false); });
    audio.addEventListener('timeupdate', function () {
      var cur = audio.currentTime || 0;
      var dur = isFinite(audio.duration) ? audio.duration : (state.currentSong ? state.currentSong.duration : 0);
      var pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
      $('mini-progress-fill').style.width = pct + '%';
      $('now-progress-fill').style.width = pct + '%';
      $('now-time-cur').textContent = formatTime(cur);
      $('now-time-dur').textContent = formatTime(dur);
      if ($('ambient-progress-fill')) $('ambient-progress-fill').style.width = pct + '%';
      if ($('ambient-time-cur')) $('ambient-time-cur').textContent = formatTime(cur);
      if ($('ambient-time-dur')) $('ambient-time-dur').textContent = formatTime(dur);
      syncLyricsToTime(cur);
    });
    audio.addEventListener('ended', function () {
      playNextSong(false);
    });
    audio.addEventListener('error', function () {
      sendClientLog('AUDIO-ELEM-ERR', state.currentSong ? state.currentSong.id : 'none');
      showToast('Luồng âm thanh gián đoạn, chuyển bài tiếp theo...');
      playNextSong(true);
    });
  }

  function init() {
    bindEvents();
    setupKeyboardAndRemote();
    ensureNativeService(function () {
      sendClientLog('APP-INIT', {
        app: 'Zing MP3 TV',
        ua: navigator.userAgent,
        nativeBridge: typeof window.PalmServiceBridge === 'function'
      });
      loadHomeData();
    });
    setTimeout(focusFirstInActiveScope, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
