// ══════════════════════════════════════════════════════════════════
//   LG MAGIC REMOTE WEB APP - CLIENT JAVASCRIPT
// ══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const statusPill = document.getElementById('status-pill');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const openSettingsBtn = document.getElementById('open-settings-btn');
  
  const statusBanner = document.getElementById('status-banner');
  const bannerTitle = document.getElementById('banner-title');
  const bannerDesc = document.getElementById('banner-desc');

  const settingsModal = document.getElementById('settings-modal');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const btnCancelSettings = document.getElementById('btn-cancel-settings');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const inpTvIp = document.getElementById('inp-tv-ip');
  const inpTvMac = document.getElementById('inp-tv-mac');
  const btnAutoScan = document.getElementById('btn-auto-scan');
  const modalMsg = document.getElementById('modal-msg');

  const btnPowerOn = document.getElementById('btn-power-on');
  const btnPowerOff = document.getElementById('btn-power-off');
  const btnPlay = document.getElementById('btn-play');
  const btnPause = document.getElementById('btn-pause');

  const toggleNumpadBtn = document.getElementById('toggle-numpad-btn');
  const numpadContainer = document.getElementById('numpad-container');

  const inpToast = document.getElementById('inp-toast');
  const btnSendToast = document.getElementById('btn-send-toast');
  const toastPopup = document.getElementById('toast-popup');

  let currentStatus = 'disconnected';
  let isPaired = false;
  let savedTvIp = '';
  let savedTvMac = '';

  // ─── PHẢN HỒI RUNG (HAPTIC VIBRATION CHO ĐIỆN THOẠI) ─────────
  function triggerHaptic(duration = 20) {
    if (window.navigator && window.navigator.vibrate) {
      try {
        window.navigator.vibrate(duration);
      } catch (_) {}
    }
  }

  // ─── THÔNG BÁO WEB TOAST ─────────────────────────────────────
  let toastTimer = null;
  function showWebToast(msg, duration = 2500) {
    toastPopup.textContent = msg;
    toastPopup.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastPopup.classList.remove('show');
    }, duration);
  }

  // ─── GỬI YÊU CẦU API ──────────────────────────────────────────
  async function apiCall(endpoint, method = 'GET', body = null) {
    try {
      const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
      };
      if (body) {
        options.body = JSON.stringify(body);
      }
      const res = await fetch(endpoint, options);
      return await res.json();
    } catch (err) {
      console.error(`Lỗi API [${endpoint}]:`, err);
      return { error: err.message };
    }
  }

  // Gửi nút bấm
  async function sendButton(buttonName) {
    triggerHaptic(20);
    const res = await apiCall('/api/button', 'POST', { name: buttonName });
    if (res.error) {
      showWebToast('⚠️ ' + res.error);
    }
  }

  // Gửi lệnh đặc biệt
  async function sendCommand(action, payload = {}) {
    triggerHaptic(30);
    const res = await apiCall('/api/command', 'POST', { action, payload });
    if (res.error) {
      showWebToast('⚠️ ' + res.error);
    } else if (res.message) {
      showWebToast('✓ ' + res.message);
    }
  }

  // ─── GÁN SỰ KIỆN NÚT TRÊN REMOTE ─────────────────────────────
  // 1. Tất cả nút có thuộc tính data-button
  document.querySelectorAll('[data-button]').forEach(btn => {
    btn.addEventListener('click', () => {
      const btnName = btn.getAttribute('data-button');
      if (btnName) {
        sendButton(btnName);
      }
    });
  });

  // 2. Mở ứng dụng (YouTube, Netflix...)
  document.querySelectorAll('[data-app]').forEach(btn => {
    btn.addEventListener('click', () => {
      const appId = btn.getAttribute('data-app');
      if (appId) {
        sendCommand('launchApp', { appId });
      }
    });
  });

  // 3. Nút Nguồn
  btnPowerOn.addEventListener('click', () => {
    sendCommand('powerOn');
  });

  btnPowerOff.addEventListener('click', () => {
    if (confirm('Bạn có chắc chắn muốn TẮT TV LG không?')) {
      sendCommand('powerOff');
    }
  });

  // 4. Media Play / Pause
  btnPlay.addEventListener('click', () => sendCommand('play'));
  btnPause.addEventListener('click', () => sendCommand('pause'));

  // 5. Gửi thông báo lên màn hình TV
  btnSendToast.addEventListener('click', () => {
    const text = inpToast.value.trim();
    if (!text) {
      showWebToast('Vui lòng nhập nội dung tin nhắn!');
      return;
    }
    sendCommand('toast', { message: text });
    inpToast.value = '';
  });

  inpToast.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnSendToast.click();
    }
  });

  // 6. Thu gọn / mở rộng Numpad
  toggleNumpadBtn.addEventListener('click', () => {
    const isHidden = numpadContainer.classList.contains('hidden');
    numpadContainer.classList.toggle('hidden', !isHidden);
    toggleNumpadBtn.querySelector('.chevron').textContent = isHidden ? '▲' : '▼';
  });

  // ─── CẬP NHẬT TRẠNG THÁI KẾT NỐI (POLLING) ───────────────────
  async function updateStatus() {
    const data = await apiCall('/api/status');
    if (!data || data.error) return;

    currentStatus = data.status || 'disconnected';
    isPaired = !!data.isPaired;
    savedTvIp = data.tvIp || '';
    savedTvMac = data.tvMac || '';

    // Cập nhật chấm và chữ trên Status Pill
    statusDot.className = 'status-dot ' + currentStatus;

    if (currentStatus === 'connected') {
      statusText.textContent = `Đã kết nối (${data.tvIp})`;
      statusBanner.classList.add('hidden');
    } else if (currentStatus === 'pairing') {
      statusText.textContent = 'Chờ chấp nhận trên TV';
      statusBanner.classList.remove('hidden');
      bannerTitle.textContent = '⚠️ Xác nhận trên màn hình TV';
      bannerDesc.textContent = 'TV đang hiển thị thông báo. Hãy dùng remote bấm [Cho phép] (Accept) trên TV!';
    } else if (currentStatus === 'connecting') {
      statusText.textContent = 'Đang kết nối...';
      statusBanner.classList.remove('hidden');
      bannerTitle.textContent = '⏳ Đang thử kết nối...';
      bannerDesc.textContent = data.message || `Đang tìm TV tại địa chỉ ${data.tvIp}`;
    } else {
      if (!data.tvIp) {
        statusText.textContent = 'Chưa cài đặt IP TV';
        statusBanner.classList.remove('hidden');
        bannerTitle.textContent = '⚙️ Chưa cài đặt IP TV';
        bannerDesc.textContent = 'Bấm vào biểu tượng bánh răng để quét hoặc nhập địa chỉ IP của TV.';
      } else {
        statusText.textContent = 'Chưa kết nối';
        statusBanner.classList.add('hidden');
      }
    }
  }

  // Khởi động cập nhật trạng thái định kỳ 3 giây
  updateStatus();
  setInterval(updateStatus, 3000);

  // ─── QUẢN LÝ MODAL CÀI ĐẶT (SETTINGS) ─────────────────────────
  function openSettings() {
    inpTvIp.value = savedTvIp;
    inpTvMac.value = savedTvMac;
    settingsModal.classList.remove('hidden');
    modalMsg.className = 'modal-msg hidden';
  }

  function closeSettings() {
    settingsModal.classList.add('hidden');
  }

  statusPill.addEventListener('click', openSettings);
  openSettingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSettings();
  });
  closeSettingsBtn.addEventListener('click', closeSettings);
  btnCancelSettings.addEventListener('click', closeSettings);

  // Đóng modal khi bấm ra ngoài vùng card
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  // Tự động quét IP theo địa chỉ MAC
  btnAutoScan.addEventListener('click', async () => {
    const mac = inpTvMac.value.trim() || savedTvMac;
    if (!mac) {
      modalMsg.className = 'modal-msg error';
      modalMsg.textContent = 'Vui lòng nhập địa chỉ MAC của TV để quét!';
      return;
    }

    btnAutoScan.disabled = true;
    btnAutoScan.textContent = '⏳ Đang quét...';
    modalMsg.className = 'modal-msg hidden';
    showWebToast('🔍 Đang dò tìm IP của TV qua Wi-Fi...');

    const res = await apiCall('/api/scan', 'POST', { mac });

    btnAutoScan.disabled = false;
    btnAutoScan.textContent = '🔍 Quét IP';

    if (res.error) {
      modalMsg.className = 'modal-msg error';
      modalMsg.textContent = 'Lỗi quét: ' + res.error;
      showWebToast('❌ ' + res.error);
    } else {
      modalMsg.className = 'modal-msg success';
      modalMsg.textContent = res.message || `Đã tìm thấy TV tại ${res.tvIp}!`;
      inpTvIp.value = res.tvIp;
      savedTvIp = res.tvIp;
      savedTvMac = res.tvMac;
      showWebToast('✓ Đã tìm thấy TV: ' + res.tvIp);
      updateStatus();
    }
  });

  // Lưu cài đặt IP & MAC thủ công
  btnSaveSettings.addEventListener('click', async () => {
    const ip = inpTvIp.value.trim();
    const mac = inpTvMac.value.trim();

    btnSaveSettings.disabled = true;
    btnSaveSettings.textContent = 'Đang lưu...';

    const res = await apiCall('/api/config', 'POST', {
      tvIp: ip,
      tvMac: mac
    });

    btnSaveSettings.disabled = false;
    btnSaveSettings.textContent = 'Lưu & Kết nối 🚀';

    if (res.error) {
      modalMsg.className = 'modal-msg error';
      modalMsg.textContent = 'Lỗi: ' + res.error;
    } else {
      modalMsg.className = 'modal-msg success';
      modalMsg.textContent = res.message || 'Đã lưu cấu hình thành công!';
      savedTvIp = ip;
      savedTvMac = mac;
      updateStatus();
      setTimeout(closeSettings, 1200);
    }
  });

  // ─── PHÍM TẮT BÀN PHÍM MÁY TÍNH (KEYBOARD SHORTCUTS) ─────────
  document.addEventListener('keydown', (e) => {
    // Không bắt phím tắt khi người dùng đang gõ trong ô input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        sendButton('UP');
        break;
      case 'ArrowDown':
        e.preventDefault();
        sendButton('DOWN');
        break;
      case 'ArrowLeft':
        e.preventDefault();
        sendButton('LEFT');
        break;
      case 'ArrowRight':
        e.preventDefault();
        sendButton('RIGHT');
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        sendButton('ENTER');
        break;
      case 'Backspace':
      case 'Escape':
        e.preventDefault();
        sendButton('BACK');
        break;
      case 'Home':
        e.preventDefault();
        sendButton('HOME');
        break;
      case '+':
      case '=':
        e.preventDefault();
        sendButton('VOLUMEUP');
        break;
      case '-':
        e.preventDefault();
        sendButton('VOLUMEDOWN');
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        sendButton('MUTE');
        break;
    }
  });

  // ─── CHUYỂN ĐỔI TAB (REMOTE / TRACKPAD / KEYBOARD) ───────────
  const navTabBtns = document.querySelectorAll('.nav-tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  navTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      triggerHaptic(15);
      const targetTabId = btn.getAttribute('data-tab');

      navTabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      tabPanes.forEach(pane => {
        if (pane.id === targetTabId) {
          pane.classList.remove('hidden');
        } else {
          pane.classList.add('hidden');
        }
      });
    });
  });

  // ─── BÀN RÊ CHUỘT (TRACKPAD VIRTUAL MOUSE) ───────────────────
  const trackpadSurface = document.getElementById('trackpad-surface');
  const btnWakePointer = document.getElementById('btn-wake-pointer');
  const btnMouseLeftClick = document.getElementById('btn-mouse-left-click');
  const btnScrollUp = document.getElementById('btn-scroll-up');
  const btnScrollDown = document.getElementById('btn-scroll-down');

  let lastTouchX = 0;
  let lastTouchY = 0;
  let touchStartTime = 0;
  let hasMovedTouch = false;
  let isMouseDown = false;
  let movePending = false;
  let accumDx = 0;
  let accumDy = 0;

  function flushMouseMove() {
    if (accumDx === 0 && accumDy === 0) {
      movePending = false;
      return;
    }
    const sendDx = Math.round(accumDx);
    const sendDy = Math.round(accumDy);
    accumDx = 0;
    accumDy = 0;

    apiCall('/api/mouse/move', 'POST', { dx: sendDx, dy: sendDy });

    setTimeout(() => {
      if (accumDx !== 0 || accumDy !== 0) {
        flushMouseMove();
      } else {
        movePending = false;
      }
    }, 20);
  }

  function queueMouseMove(dx, dy) {
    accumDx += dx;
    accumDy += dy;
    if (!movePending) {
      movePending = true;
      flushMouseMove();
    }
  }

  async function triggerMouseClick() {
    triggerHaptic(25);
    await apiCall('/api/mouse/click', 'POST');
  }

  async function triggerMouseScroll(dy) {
    triggerHaptic(15);
    await apiCall('/api/mouse/scroll', 'POST', { dx: 0, dy });
  }

  // 1. Touch events (Điện thoại / Cảm ứng)
  if (trackpadSurface) {
    trackpadSurface.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        lastTouchX = e.touches[0].clientX;
        lastTouchY = e.touches[0].clientY;
        touchStartTime = Date.now();
        hasMovedTouch = false;
        trackpadSurface.classList.add('active');
      }
    }, { passive: true });

    trackpadSurface.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        const curX = e.touches[0].clientX;
        const curY = e.touches[0].clientY;
        const dx = (curX - lastTouchX) * 1.8;
        const dy = (curY - lastTouchY) * 1.8;

        if (Math.hypot(curX - lastTouchX, curY - lastTouchY) > 3) {
          hasMovedTouch = true;
        }

        lastTouchX = curX;
        lastTouchY = curY;
        queueMouseMove(dx, dy);
      }
    }, { passive: true });

    trackpadSurface.addEventListener('touchend', (e) => {
      trackpadSurface.classList.remove('active');
      const touchDuration = Date.now() - touchStartTime;
      // Chạm nhẹ và nhanh -> Click
      if (!hasMovedTouch && touchDuration < 280) {
        triggerMouseClick();
      }
    });

    // 2. Mouse events (Kéo chuột trên PC)
    trackpadSurface.addEventListener('mousedown', (e) => {
      isMouseDown = true;
      lastTouchX = e.clientX;
      lastTouchY = e.clientY;
      touchStartTime = Date.now();
      hasMovedTouch = false;
      trackpadSurface.classList.add('active');
    });

    window.addEventListener('mousemove', (e) => {
      if (isMouseDown) {
        const dx = (e.clientX - lastTouchX) * 1.8;
        const dy = (e.clientY - lastTouchY) * 1.8;
        if (Math.hypot(e.clientX - lastTouchX, e.clientY - lastTouchY) > 3) {
          hasMovedTouch = true;
        }
        lastTouchX = e.clientX;
        lastTouchY = e.clientY;
        queueMouseMove(dx, dy);
      }
    });

    window.addEventListener('mouseup', () => {
      if (isMouseDown) {
        isMouseDown = false;
        trackpadSurface.classList.remove('active');
        if (!hasMovedTouch && Date.now() - touchStartTime < 250) {
          triggerMouseClick();
        }
      }
    });
  }

  // Nút hỗ trợ chuột
  if (btnMouseLeftClick) {
    btnMouseLeftClick.addEventListener('click', triggerMouseClick);
  }
  if (btnScrollUp) {
    btnScrollUp.addEventListener('click', () => triggerMouseScroll(120));
  }
  if (btnScrollDown) {
    btnScrollDown.addEventListener('click', () => triggerMouseScroll(-120));
  }
  if (btnWakePointer) {
    btnWakePointer.addEventListener('click', () => {
      triggerHaptic(20);
      queueMouseMove(10, 10);
      setTimeout(() => queueMouseMove(-10, -10), 100);
      showWebToast('✨ Đã đánh thức con trỏ trên TV');
    });
  }

  // ─── BÀN PHÍM & MỞ WEB TRÊN TV (KEYBOARD & WEB BROWSER) ──────
  const inpWebUrl = document.getElementById('inp-web-url');
  const btnOpenWeb = document.getElementById('btn-open-web');
  const inpTvText = document.getElementById('inp-tv-text');
  const btnSendText = document.getElementById('btn-send-text');
  const btnSendEnter = document.getElementById('btn-send-enter');
  const btnSendBackspace = document.getElementById('btn-send-backspace');
  const btnClearText = document.getElementById('btn-clear-text');

  async function openUrl(url) {
    const clean = (url || '').trim();
    if (!clean) {
      showWebToast('⚠️ Vui lòng nhập địa chỉ trang web!');
      return;
    }
    triggerHaptic(20);
    showWebToast('🌐 Đang mở web trên TV: ' + clean);
    const res = await apiCall('/api/browser/open', 'POST', { url: clean });
    if (res.error) showWebToast('❌ ' + res.error);
  }

  if (btnOpenWeb) {
    btnOpenWeb.addEventListener('click', () => {
      openUrl(inpWebUrl.value);
    });
  }

  if (inpWebUrl) {
    inpWebUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        openUrl(inpWebUrl.value);
      }
    });
  }

  // Các nút truy cập nhanh web
  document.querySelectorAll('.quick-site-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const u = btn.getAttribute('data-url');
      if (u) {
        if (inpWebUrl) inpWebUrl.value = u;
        openUrl(u);
      }
    });
  });

  // Gửi chữ vào ô tìm kiếm trên TV
  if (btnSendText) {
    btnSendText.addEventListener('click', async () => {
      const text = inpTvText.value;
      if (!text) {
        showWebToast('⚠️ Vui lòng nhập nội dung cần gõ!');
        return;
      }
      triggerHaptic(20);
      showWebToast('⌨️ Đang gửi chữ lên TV...');
      const res = await apiCall('/api/ime/text', 'POST', { text });
      if (res.error) {
        showWebToast('❌ ' + res.error);
      } else {
        showWebToast('✓ Đã điền chữ lên TV!');
      }
    });
  }

  if (btnSendEnter) {
    btnSendEnter.addEventListener('click', async () => {
      triggerHaptic(20);
      await apiCall('/api/ime/enter', 'POST');
      showWebToast('↵ Đã gửi phím Enter');
    });
  }

  if (btnSendBackspace) {
    btnSendBackspace.addEventListener('click', async () => {
      triggerHaptic(15);
      await apiCall('/api/ime/backspace', 'POST', { count: 1 });
    });
  }

  if (btnClearText) {
    btnClearText.addEventListener('click', () => {
      inpTvText.value = '';
      inpTvText.focus();
    });
  }

  // ─── TAB 4: CHIA SẺ MÀN HÌNH (SCREEN SHARE WEBRTC) ────────────
  const btnStartCast = document.getElementById('btn-start-cast');
  const btnStopCast = document.getElementById('btn-stop-cast');
  const btnOpenTvCast = document.getElementById('btn-open-tv-cast');
  const castStatusPill = document.getElementById('cast-status-pill');
  const castPreviewBox = document.getElementById('cast-preview-box');
  const castPreviewVideo = document.getElementById('cast-preview-video');
  const chkShareAudio = document.getElementById('chk-share-audio');
  const chkHighFps = document.getElementById('chk-high-fps');

  let localScreenStream = null;
  let castWs = null;
  let castPc = null;

  function initCastWs() {
    if (castWs && castWs.readyState === WebSocket.OPEN) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    castWs = new WebSocket(`${protocol}//${location.host}/cast-ws`);

    castWs.onopen = () => {
      console.log('[Sender-Cast] Đã kết nối WebSocket signaling');
      castWs.send(JSON.stringify({ role: 'sender' }));
    };

    castWs.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'receiver_ready') {
          console.log('[Sender-Cast] Màn hình nhận TV đã sẵn sàng! Bắt đầu gửi Offer...');
          if (localScreenStream) {
            createAndSendOffer();
          }
        } else if (msg.type === 'answer' && castPc) {
          console.log('[Sender-Cast] Nhận Answer từ TV, hoàn tất WebRTC handshake');
          await castPc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        } else if (msg.type === 'candidate' && castPc) {
          if (msg.candidate) {
            await castPc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        } else if (msg.type === 'receiver_disconnected') {
          console.log('[Sender-Cast] TV Receiver đã ngắt kết nối');
          showWebToast('⚠️ TV đã đóng màn hình chia sẻ');
        }
      } catch (err) {
        console.error('[Sender-Cast] Lỗi signaling:', err);
      }
    };
  }

  async function createAndSendOffer() {
    if (!localScreenStream) return;
    if (castPc) castPc.close();

    castPc = new RTCPeerConnection({ iceServers: [] });

    localScreenStream.getTracks().forEach(track => {
      castPc.addTrack(track, localScreenStream);
    });

    castPc.onicecandidate = (event) => {
      if (event.candidate && castWs && castWs.readyState === WebSocket.OPEN) {
        castWs.send(JSON.stringify({
          target: 'receiver',
          type: 'candidate',
          candidate: event.candidate
        }));
      }
    };

    const offer = await castPc.createOffer();
    await castPc.setLocalDescription(offer);

    if (castWs && castWs.readyState === WebSocket.OPEN) {
      castWs.send(JSON.stringify({
        target: 'receiver',
        type: 'offer',
        sdp: castPc.localDescription
      }));
    }
  }

  async function startScreenShare() {
    try {
      const shareAudio = chkShareAudio ? chkShareAudio.checked : true;
      const highFps = chkHighFps ? chkHighFps.checked : true;

      const constraints = {
        video: {
          cursor: 'always',
          frameRate: { ideal: highFps ? 60 : 30, max: 60 }
        },
        audio: shareAudio
      };

      localScreenStream = await navigator.mediaDevices.getDisplayMedia(constraints);

      // Hiển thị preview
      if (castPreviewVideo) {
        castPreviewVideo.srcObject = localScreenStream;
        castPreviewBox.classList.remove('hidden');
      }

      btnStartCast.classList.add('hidden');
      btnStopCast.classList.remove('hidden');
      castStatusPill.className = 'cast-status-pill live';
      castStatusPill.textContent = 'Đang phát (Live)';

      // Kết nối WebSocket signaling
      initCastWs();

      // Tự động gọi TV mở cast.html
      showWebToast('📺 Đang gửi lệnh mở màn hình trên TV...');
      apiCall('/api/cast/open-tv', 'POST');

      // Khi người dùng bấm "Stop sharing" trên thanh công cụ của trình duyệt
      localScreenStream.getVideoTracks()[0].onended = () => {
        stopScreenShare();
      };

    } catch (err) {
      console.error('Lỗi khi mở getDisplayMedia:', err);
      showWebToast('⚠️ Bạn đã hủy hoặc không cấp quyền chia sẻ màn hình');
      stopScreenShare();
    }
  }

  function stopScreenShare() {
    if (localScreenStream) {
      localScreenStream.getTracks().forEach(t => t.stop());
      localScreenStream = null;
    }
    if (castPc) {
      castPc.close();
      castPc = null;
    }
    if (castWs && castWs.readyState === WebSocket.OPEN) {
      castWs.send(JSON.stringify({ target: 'receiver', type: 'stop' }));
    }

    if (castPreviewVideo) castPreviewVideo.srcObject = null;
    if (castPreviewBox) castPreviewBox.classList.add('hidden');
    if (btnStartCast) btnStartCast.classList.remove('hidden');
    if (btnStopCast) btnStopCast.classList.add('hidden');
    if (castStatusPill) {
      castStatusPill.className = 'cast-status-pill idle';
      castStatusPill.textContent = 'Chưa phát';
    }

    showWebToast('⏹️ Đã dừng chia sẻ màn hình');
  }

  if (btnStartCast) btnStartCast.addEventListener('click', startScreenShare);
  if (btnStopCast) btnStopCast.addEventListener('click', stopScreenShare);
  if (btnOpenTvCast) {
    btnOpenTvCast.addEventListener('click', () => {
      showWebToast('📺 Đang mở trang nhận trên TV...');
      apiCall('/api/cast/open-tv', 'POST');
    });
  }
});
