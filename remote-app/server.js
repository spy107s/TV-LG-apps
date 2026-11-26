const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const dgram = require('dgram');
const { exec } = require('child_process');
const os = require('os');
const http = require('http');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Cho phép tất cả request từ mọi nguồn (Accept all origins / methods / headers)
app.use(cors({
  origin: '*',
  methods: '*',
  allowedHeaders: '*'
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CẤU HÌNH & TRẠNG THÁI ─────────────────────────────────────
let config = {
  tvIp: '',
  tvMac: '',
  clientKey: ''
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      config = { ...config, ...JSON.parse(data) };
    }
  } catch (err) {
    console.error('Lỗi khi đọc config.json:', err.message);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Lỗi khi lưu config.json:', err.message);
  }
}

loadConfig();

let tvWs = null;
let pointerWs = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'pairing' | 'connected'
let statusMessage = config.tvIp ? 'Chưa kết nối' : 'Vui lòng nhập địa chỉ IP của TV LG';
let reqId = 1;
const pendingCallbacks = new Map();
let installedApps = [];
let heartbeatTimer = null;
let reconnectTimer = null;

// ─── GIAO TIẾP VỚI TV LG (SSAP WEBSOCKET) ───────────────────────
function buildRegistrationPayload(clientKey) {
  const payload = {
    forcePairing: false,
    pairingType: 'PROMPT',
    manifest: {
      manifestVersion: 1,
      appVersion: '1.0',
      signed: {
        created: '20140509',
        appId: 'com.lge.test',
        vendorId: 'com.lge',
        localizedAppNames: {
          '': 'LG Web Remote',
          'ko-KR': '리모컨',
          'zxx-XX': 'LG Web Remote'
        },
        localizedVendorNames: {
          '': 'LG Electronics'
        },
        permissions: [
          'TEST_SECURE',
          'CONTROL_INPUT_TEXT',
          'CONTROL_MOUSE_AND_KEYBOARD',
          'READ_INSTALLED_APPS',
          'READ_LGE_USERS',
          'READ_CURRENT_CHANNEL',
          'READ_RUNNING_APPS',
          'READ_COUNTRY_INFO',
          'READ_SETTINGS',
          'CONTROL_TV_SCREEN',
          'CONTROL_TV_POWER',
          'READ_TV_CURRENT_TIME',
          'WRITE_NOTIFICATION_TOAST',
          'READ_INPUT_DEVICE_LIST',
          'READ_NETWORK_STATE',
          'READ_TV_CHANNEL_LIST',
          'WRITE_SETTINGS',
          'CONTROL_INPUT_JOYSTICK',
          'CONTROL_INPUT_MEDIA_RECORDING',
          'CONTROL_INPUT_MEDIA_PLAYBACK',
          'CONTROL_INPUT_TV',
          'CONTROL_POWER',
          'READ_APP_STATUS'
        ],
        serial: '2f930e2d2cdc085a37f882cbcf267c86'
      },
      permissions: [
        'LAUNCH',
        'LAUNCH_WEBAPP',
        'APP_TO_APP',
        'CLOSE',
        'TEST_OPEN',
        'TEST_PROTECTED',
        'CONTROL_AUDIO',
        'CONTROL_DISPLAY',
        'CONTROL_INPUT_JOYSTICK',
        'CONTROL_INPUT_MEDIA_RECORDING',
        'CONTROL_INPUT_MEDIA_PLAYBACK',
        'CONTROL_INPUT_TV',
        'CONTROL_POWER',
        'READ_APP_STATUS',
        'READ_CURRENT_CHANNEL',
        'READ_INPUT_DEVICE_LIST',
        'READ_NETWORK_STATE',
        'READ_RUNNING_APPS',
        'READ_TV_CHANNEL_LIST',
        'WRITE_NOTIFICATION_TOAST',
        'READ_POWER_STATE',
        'READ_COUNTRY_INFO',
        'CONTROL_MOUSE_AND_KEYBOARD',
        'CONTROL_INPUT_TEXT',
        'ssap://com.webos.service.networkinput/getPointerInputSocket',
        'ssap://com.webos.service.ime/insertText',
        'ssap://com.webos.service.ime/sendEnterKey',
        'ssap://com.webos.service.ime/deleteCharacters'
      ]
    }
  };

  if (clientKey) {
    payload['client-key'] = clientKey;
  }
  return payload;
}

function cleanupSockets() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (pointerWs) {
    try { pointerWs.close(); } catch (_) {}
    pointerWs = null;
  }
  if (tvWs) {
    try { tvWs.close(); } catch (_) {}
    tvWs = null;
  }
  pendingCallbacks.clear();
}

function connectToTv(overrideIp) {
  const targetIp = (overrideIp || config.tvIp || '').trim();
  if (!targetIp) {
    connectionStatus = 'disconnected';
    statusMessage = 'Vui lòng nhập địa chỉ IP của TV LG trong phần Cài đặt!';
    return;
  }

  cleanupSockets();
  connectionStatus = 'connecting';
  statusMessage = `Đang kết nối tới TV (${targetIp})...`;
  console.log(`[LG-TV] Bắt đầu kết nối tới: ${targetIp}`);

  // Thử cổng 3001 (WSS - webOS 4.5+ / 2021) trước, nếu không được chuyển sang 3000 (WS)
  tryConnectUrl(`wss://${targetIp}:3001`, () => {
    console.log('[LG-TV] WSS 3001 không phản hồi, thử cổng WS 3000...');
    tryConnectUrl(`ws://${targetIp}:3000`, null);
  });
}

function tryConnectUrl(url, fallbackFn) {
  try {
    const ws = new WebSocket(url, {
      rejectUnauthorized: false,
      handshakeTimeout: 4000
    });

    let isEstablished = false;

    ws.on('open', () => {
      isEstablished = true;
      tvWs = ws;
      console.log(`[LG-TV] WebSocket mở thành công: ${url}`);
      statusMessage = 'Đang xác thực với TV...';

      // Gửi gói tin đăng ký (Register)
      const regMsg = {
        type: 'register',
        id: 'reg_client',
        payload: buildRegistrationPayload(config.clientKey)
      };
      ws.send(JSON.stringify(regMsg));

      // Bắt đầu nhịp tim giữ kết nối
      heartbeatTimer = setInterval(() => {
        if (tvWs && tvWs.readyState === WebSocket.OPEN) {
          sendSsap('ssap://system/getTime', {}, null);
        }
      }, 15000);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleTvMessage(msg);
      } catch (err) {
        console.error('[LG-TV] Lỗi parse JSON:', err);
      }
    });

    ws.on('error', (err) => {
      console.warn(`[LG-TV] Lỗi kết nối (${url}):`, err.message);
      if (!isEstablished && fallbackFn) {
        fallbackFn();
      }
    });

    ws.on('close', () => {
      console.log(`[LG-TV] Đã ngắt kết nối (${url})`);
      if (tvWs === ws) {
        tvWs = null;
        connectionStatus = 'disconnected';
        statusMessage = 'Đã mất kết nối tới TV. Sẽ thử kết nối lại...';
      }
    });
  } catch (err) {
    console.error(`[LG-TV] Lỗi khởi tạo WebSocket (${url}):`, err.message);
    if (fallbackFn) fallbackFn();
  }
}

function handleTvMessage(msg) {
  const { type, id, payload } = msg;

  // Xử lý đăng ký / ghép đôi
  if (id === 'reg_client') {
    if (payload && payload['client-key']) {
      config.clientKey = payload['client-key'];
      saveConfig();
      connectionStatus = 'connected';
      statusMessage = 'Đã kết nối và xác thực thành công!';
      console.log('[LG-TV] Ghép đôi thành công! Client Key đã lưu.');
      
      // Khởi tạo socket con trỏ / nút bấm chuyên dụng
      initPointerSocket();
      // Lấy danh sách app
      fetchInstalledApps();
    } else if (payload && payload.pairingType === 'PROMPT') {
      connectionStatus = 'pairing';
      statusMessage = '⚠️ Vui lòng nhìn màn hình TV và bấm [Cho phép] (Accept)!';
      console.log('[LG-TV] TV đang hiện thông báo ghép đôi. Đang chờ người dùng bấm Cho phép...');
    }
  }

  // Xử lý các request có callback
  if (id && pendingCallbacks.has(id)) {
    const cb = pendingCallbacks.get(id);
    pendingCallbacks.delete(id);
    if (typeof cb === 'function') {
      cb(null, payload);
    }
  }
}

function sendSsap(uri, payload = {}, callback = null) {
  if (!tvWs || tvWs.readyState !== WebSocket.OPEN) {
    if (callback) callback(new Error('Chưa kết nối tới TV!'));
    return false;
  }

  const currentId = 'req_' + (reqId++);
  if (callback) {
    pendingCallbacks.set(currentId, callback);
    // Timeout cho request
    setTimeout(() => {
      if (pendingCallbacks.has(currentId)) {
        pendingCallbacks.delete(currentId);
        callback(new Error('Hết thời gian chờ phản hồi từ TV'));
      }
    }, 8000);
  }

  const msg = {
    id: currentId,
    type: 'request',
    uri,
    payload
  };

  tvWs.send(JSON.stringify(msg));
  return true;
}

// ─── SOCKET CON TRỎ & NÚT BẤM (POINTER SOCKET) ────────────────
function initPointerSocket() {
  sendSsap('ssap://com.webos.service.networkinput/getPointerInputSocket', {}, (err, res) => {
    if (err || !res || !res.socketPath) {
      console.warn('[LG-TV] Không lấy được PointerInputSocket, sẽ dùng lệnh SSAP thông thường.', err?.message);
      return;
    }

    try {
      console.log('[LG-TV] Đang kết nối Pointer Input Socket:', res.socketPath);
      const pWs = new WebSocket(res.socketPath, { rejectUnauthorized: false });

      pWs.on('open', () => {
        pointerWs = pWs;
        console.log('[LG-TV] Pointer Input Socket đã sẵn sàng!');
      });

      pWs.on('error', (e) => {
        console.warn('[LG-TV] Pointer Socket error:', e.message);
      });

      pWs.on('close', () => {
        console.log('[LG-TV] Pointer Socket đóng.');
        if (pointerWs === pWs) pointerWs = null;
      });
    } catch (e) {
      console.error('[LG-TV] Lỗi tạo pointer socket:', e.message);
    }
  });
}

function sendButton(btnName) {
  btnName = btnName.toUpperCase();
  // Ưu tiên dùng pointer socket vì mượt mà và hỗ trợ D-Pad / OK / Back / Home
  if (pointerWs && pointerWs.readyState === WebSocket.OPEN) {
    pointerWs.send(`type:button\nname:${btnName}\n\n`);
    return true;
  }

  // Fallback qua các lệnh SSAP chuẩn
  const fallbackMap = {
    'UP': 'ssap://com.webos.service.networkinput/up',
    'DOWN': 'ssap://com.webos.service.networkinput/down',
    'LEFT': 'ssap://com.webos.service.networkinput/left',
    'RIGHT': 'ssap://com.webos.service.networkinput/right',
    'ENTER': 'ssap://com.webos.service.networkinput/enter',
    'BACK': 'ssap://com.webos.service.networkinput/back',
    'HOME': 'ssap://system.launcher/open',
    'VOLUMEUP': 'ssap://audio/volumeUp',
    'VOLUMEDOWN': 'ssap://audio/volumeDown',
    'MUTE': 'ssap://audio/setMute',
    'CHANNELUP': 'ssap://tv/channelUp',
    'CHANNELDOWN': 'ssap://tv/channelDown'
  };

  if (fallbackMap[btnName]) {
    return sendSsap(fallbackMap[btnName]);
  }

  // Thử kết nối lại pointer socket nếu chưa có
  if (connectionStatus === 'connected' && !pointerWs) {
    initPointerSocket();
  }

  return false;
}

// ─── CHỨC NĂNG CHUỘT ẢO (TRACKPAD / MOUSE) ─────────────────────
function sendMouseMove(dx, dy) {
  if (pointerWs && pointerWs.readyState === WebSocket.OPEN) {
    pointerWs.send(`type:move\ndx:${dx}\ndy:${dy}\ndown:0\n\n`);
    return true;
  }
  if (connectionStatus === 'connected' && !pointerWs) {
    initPointerSocket();
  }
  return false;
}

function sendMouseClick() {
  if (pointerWs && pointerWs.readyState === WebSocket.OPEN) {
    pointerWs.send('type:click\n\n');
    return true;
  }
  if (connectionStatus === 'connected' && !pointerWs) {
    initPointerSocket();
  }
  return false;
}

function sendMouseScroll(dx, dy) {
  if (pointerWs && pointerWs.readyState === WebSocket.OPEN) {
    pointerWs.send(`type:scroll\ndx:${dx}\ndy:${dy}\n\n`);
    return true;
  }
  return false;
}

// ─── CHỨC NĂNG BÀN PHÍM & GÕ CHỮ (IME) ─────────────────────────
function sendInsertText(text, callback) {
  sendSsap('ssap://com.webos.service.ime/insertText', { text, replace: 0 }, callback);
}

function sendEnterKey(callback) {
  sendSsap('ssap://com.webos.service.ime/sendEnterKey', {}, callback);
}

function sendBackspace(count = 1, callback) {
  sendSsap('ssap://com.webos.service.ime/deleteCharacters', { count }, callback);
}

// ─── MỞ TRÌNH DUYỆT WEB VỚI URL ────────────────────────────────
function openBrowserUrl(url, callback) {
  let target = (url || '').trim();
  if (!target) {
    if (callback) callback(new Error('URL không được để trống!'));
    return false;
  }
  if (!/^https?:\/\//i.test(target)) {
    target = 'https://' + target;
  }
  return sendSsap('ssap://system.launcher/open', { target }, callback);
}

function fetchInstalledApps() {
  sendSsap('ssap://com.webos.applicationManager/listLaunchPoints', {}, (err, res) => {
    if (!err && res && Array.isArray(res.launchPoints)) {
      installedApps = res.launchPoints.map(app => ({
        id: app.id,
        title: app.title,
        icon: app.iconLarge || app.icon,
        bgImage: app.bgImage
      }));
      console.log(`[LG-TV] Đã lấy ${installedApps.length} ứng dụng cài trên TV.`);
    }
  });
}

// ─── WAKE-ON-LAN (BẬT NGUỒN QUA WI-FI) ─────────────────────────
function sendWakeOnLan(macAddress, callback) {
  if (!macAddress) {
    if (callback) callback(new Error('Chưa cung cấp địa chỉ MAC!'));
    return;
  }

  const cleanMac = macAddress.replace(/[^0-9a-fA-F]/g, '');
  if (cleanMac.length !== 12) {
    if (callback) callback(new Error('Địa chỉ MAC không hợp lệ! (Phải đủ 12 ký tự hex)'));
    return;
  }

  const macBuffer = Buffer.from(cleanMac, 'hex');
  // Magic packet: 6 bytes 0xFF theo sau là 16 lần lặp MAC (tổng 102 bytes)
  const magicPacket = Buffer.alloc(102);
  magicPacket.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) {
    macBuffer.copy(magicPacket, 6 + i * 6);
  }

  const socket = dgram.createSocket('udp4');
  socket.once('error', (err) => {
    socket.close();
    if (callback) callback(err);
  });

  socket.bind(0, () => {
    socket.setBroadcast(true);
    socket.send(magicPacket, 0, magicPacket.length, 9, '255.255.255.255', (err) => {
      socket.close();
      if (callback) callback(err);
    });
  });
}

// ─── TỰ ĐỘNG QUÉT TÌM IP THEO ĐỊA CHỈ MAC ──────────────────────
function findIpByMac(targetMac, callback) {
  if (!targetMac) {
    return callback(new Error('Chưa cung cấp địa chỉ MAC!'));
  }

  const normalizedMac = targetMac.toLowerCase().replace(/[:-]/g, '-');

  function checkArp(cb) {
    exec('arp -a', (err, stdout) => {
      if (err) return cb(err);
      const lines = stdout.split('\n');
      for (const line of lines) {
        const clean = line.trim().toLowerCase();
        if (clean.includes(normalizedMac)) {
          const parts = clean.split(/\s+/);
          if (parts.length >= 2) {
            const foundIp = parts[0];
            return cb(null, foundIp);
          }
        }
      }
      cb(null, null);
    });
  }

  // Bước 1: Kiểm tra bảng ARP hiện tại
  checkArp((err, foundIp) => {
    if (!err && foundIp) {
      console.log(`[Auto-Scan] Tìm thấy TV trong bảng ARP: ${foundIp} (MAC: ${targetMac})`);
      return callback(null, foundIp);
    }

    // Bước 2: Quét subnet nếu chưa có trong cache ARP
    console.log('[Auto-Scan] Chưa có trong cache ARP, đang quét subnet để làm mới...');
    const interfaces = os.networkInterfaces();
    let subnetPrefix = '192.168.1';
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const parts = iface.address.split('.');
          if (parts.length === 4) {
            subnetPrefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
            break;
          }
        }
      }
    }

    exec(`cmd.exe /c "for /L %i in (1,1,30) do @start /b ping -n 1 -w 100 ${subnetPrefix}.%i >nul"`, () => {
      setTimeout(() => {
        checkArp((err2, foundIp2) => {
          if (!err2 && foundIp2) {
            console.log(`[Auto-Scan] Sau khi làm mới, tìm thấy TV tại: ${foundIp2}`);
            return callback(null, foundIp2);
          }
          callback(new Error(`Không tìm thấy thiết bị có MAC ${targetMac} trong mạng ${subnetPrefix}.0/24`));
        });
      }, 1500);
    });
  });
}

// Tự động kết nối hoặc quét IP khi khởi động
if (config.tvIp) {
  setTimeout(() => connectToTv(), 1500);
} else if (config.tvMac) {
  console.log(`[LG-TV] IP đang trống. Đang tự động quét tìm IP theo MAC: ${config.tvMac}...`);
  findIpByMac(config.tvMac, (err, foundIp) => {
    if (!err && foundIp) {
      config.tvIp = foundIp;
      saveConfig();
      connectToTv(foundIp);
    }
  });
}

// ─── CÁC API CHO FRONTEND (REST API) ───────────────────────────

// 1. Trạng thái kết nối
app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    message: statusMessage,
    tvIp: config.tvIp,
    tvMac: config.tvMac,
    isPaired: !!config.clientKey,
    hasPointerSocket: !!(pointerWs && pointerWs.readyState === WebSocket.OPEN),
    appCount: installedApps.length
  });
});

// 2. Lưu cài đặt IP & MAC
app.post('/api/config', (req, res) => {
  const { tvIp, tvMac } = req.body;
  let changed = false;

  if (typeof tvIp === 'string') {
    const clean = tvIp.trim();
    if (clean !== config.tvIp) {
      config.tvIp = clean;
      config.clientKey = ''; // Đổi IP mới thì xóa key cũ để xác thực lại
      changed = true;
    }
  }

  if (typeof tvMac === 'string') {
    config.tvMac = tvMac.trim();
    changed = true;
  }

  if (changed) {
    saveConfig();
  }

  // Thử kết nối nếu có IP
  if (config.tvIp) {
    connectToTv();
  }

  res.json({
    success: true,
    tvIp: config.tvIp,
    tvMac: config.tvMac,
    message: config.tvIp ? 'Đã lưu cấu hình và đang kết nối...' : 'Đã lưu (IP đang để trống)'
  });
});

// 3. Kết nối / Ghép đôi lại thủ công
app.post('/api/connect', (req, res) => {
  if (req.body && req.body.tvIp) {
    config.tvIp = req.body.tvIp.trim();
    saveConfig();
  }
  connectToTv();
  res.json({ success: true, message: 'Đang gửi yêu cầu kết nối tới TV...' });
});

// 4. Nhấn nút điều hướng / chức năng (Button)
app.post('/api/button', (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Thiếu tên nút (name)' });
  }

  const ok = sendButton(name);
  res.json({ success: ok, button: name });
});

// 5. Các lệnh điều khiển hệ thống (Commands)
app.post('/api/command', (req, res) => {
  const { action, payload = {} } = req.body;

  switch (action) {
    case 'powerOn': // Bật nguồn qua Wake-on-LAN
      sendWakeOnLan(config.tvMac, (err) => {
        if (err) {
          return res.status(500).json({ error: 'Lỗi gửi gói tin Wake-on-LAN: ' + err.message });
        }
        res.json({ success: true, message: 'Đã phát tín hiệu bật nguồn (WoL) tới TV!' });
      });
      break;

    case 'powerOff': // Tắt nguồn TV
      sendSsap('ssap://system/turnOff', {}, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Đã gửi lệnh tắt TV' });
      });
      break;

    case 'volumeUp':
      sendButton('VOLUMEUP');
      res.json({ success: true });
      break;

    case 'volumeDown':
      sendButton('VOLUMEDOWN');
      res.json({ success: true });
      break;

    case 'mute':
      sendButton('MUTE');
      res.json({ success: true });
      break;

    case 'channelUp':
      sendButton('CHANNELUP');
      res.json({ success: true });
      break;

    case 'channelDown':
      sendButton('CHANNELDOWN');
      res.json({ success: true });
      break;

    case 'play':
      sendSsap('ssap://media.controls/play');
      res.json({ success: true });
      break;

    case 'pause':
      sendSsap('ssap://media.controls/pause');
      res.json({ success: true });
      break;

    case 'stop':
      sendSsap('ssap://media.controls/stop');
      res.json({ success: true });
      break;

    case 'toast': // Hiện thông báo trên màn hình TV
      if (!payload.message) return res.status(400).json({ error: 'Thiếu nội dung message' });
      sendSsap('ssap://system.notifications/createToast', { message: payload.message }, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Đã gửi thông báo lên TV!' });
      });
      break;

    case 'launchApp': // Mở ứng dụng
      if (!payload.appId) return res.status(400).json({ error: 'Thiếu appId' });
      sendSsap('ssap://system.launcher/launch', { id: payload.appId }, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Đã mở ứng dụng: ' + payload.appId });
      });
      break;

    default:
      res.status(400).json({ error: 'Lệnh không hợp lệ: ' + action });
  }
});

// 6. Danh sách ứng dụng đã cài
app.get('/api/apps', (req, res) => {
  res.json({ apps: installedApps });
});

// 7. Tự động quét tìm IP theo địa chỉ MAC
app.post('/api/scan', (req, res) => {
  const targetMac = (req.body && req.body.mac) || config.tvMac;
  if (!targetMac) {
    return res.status(400).json({ error: 'Chưa có địa chỉ MAC để quét!' });
  }

  console.log(`[Auto-Scan] Đang quét IP cho MAC: ${targetMac}...`);
  findIpByMac(targetMac, (err, foundIp) => {
    if (err || !foundIp) {
      return res.status(404).json({ error: err ? err.message : 'Không tìm thấy IP của TV!' });
    }

    let changed = false;
    if (config.tvIp !== foundIp) {
      config.tvIp = foundIp;
      changed = true;
    }
    if (config.tvMac !== targetMac) {
      config.tvMac = targetMac;
      changed = true;
    }
    if (changed) {
      saveConfig();
    }

    // Kết nối ngay với IP vừa tìm được
    connectToTv(foundIp);

    res.json({
      success: true,
      tvIp: foundIp,
      tvMac: targetMac,
      message: `Đã tự động tìm thấy TV tại IP: ${foundIp}!`
    });
  });
});

// 8. Điều khiển Chuột ảo (Trackpad)
app.post('/api/mouse/move', (req, res) => {
  const { dx, dy } = req.body;
  const ok = sendMouseMove(dx || 0, dy || 0);
  res.json({ success: ok });
});

app.post('/api/mouse/click', (req, res) => {
  const ok = sendMouseClick();
  res.json({ success: ok });
});

app.post('/api/mouse/scroll', (req, res) => {
  const { dx, dy } = req.body;
  const ok = sendMouseScroll(dx || 0, dy || 0);
  res.json({ success: ok });
});

// 9. Bàn phím gõ chữ (Virtual Keyboard / IME)
app.post('/api/ime/text', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Nội dung chữ trống' });
  sendInsertText(text, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, text });
  });
});

app.post('/api/ime/enter', (req, res) => {
  sendEnterKey((err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.post('/api/ime/backspace', (req, res) => {
  const count = (req.body && req.body.count) || 1;
  sendBackspace(count, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// 10. Mở trình duyệt Web TV với URL
app.post('/api/browser/open', (req, res) => {
  const { url } = req.body;
  openBrowserUrl(url, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: `Đang mở ${url} trên TV!` });
  });
});

// 11. Tự động mở trang nhận Cast màn hình trên TV
app.post('/api/cast/open-tv', (req, res) => {
  const interfaces = os.networkInterfaces();
  let localIp = '127.0.0.1';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIp = iface.address;
        break;
      }
    }
  }

  const castUrl = `http://${localIp}:${PORT}/cast.html`;
  console.log(`[Cast] Đang gửi lệnh mở màn hình Cast trên TV: ${castUrl}`);
  openBrowserUrl(castUrl, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, url: castUrl, message: `Đang mở màn hình nhận trên TV: ${castUrl}` });
  });
});

// ─── WEBSOCKET SIGNALING CHO CHIA SẺ MÀN HÌNH (WEBRTC) ─────────
const castWss = new WebSocket.Server({ server, path: '/cast-ws' });
let senderClient = null;
let receiverClient = null;

castWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.role === 'sender') {
        senderClient = ws;
        console.log('[Cast] PC Sender (Máy phát) đã kết nối!');
        if (receiverClient && receiverClient.readyState === WebSocket.OPEN) {
          senderClient.send(JSON.stringify({ type: 'receiver_ready' }));
        }
      } else if (msg.role === 'receiver') {
        receiverClient = ws;
        console.log('[Cast] TV Receiver (Màn hình nhận) đã kết nối!');
        if (senderClient && senderClient.readyState === WebSocket.OPEN) {
          senderClient.send(JSON.stringify({ type: 'receiver_ready' }));
        }
      } else if (msg.target === 'receiver' && receiverClient && receiverClient.readyState === WebSocket.OPEN) {
        receiverClient.send(JSON.stringify(msg));
      } else if (msg.target === 'sender' && senderClient && senderClient.readyState === WebSocket.OPEN) {
        senderClient.send(JSON.stringify(msg));
      }
    } catch (e) {
      console.error('[Cast] Lỗi parse signaling:', e.message);
    }
  });

  ws.on('close', () => {
    if (ws === senderClient) {
      senderClient = null;
      console.log('[Cast] PC Sender đã ngắt.');
      if (receiverClient && receiverClient.readyState === WebSocket.OPEN) {
        receiverClient.send(JSON.stringify({ type: 'sender_disconnected' }));
      }
    }
    if (ws === receiverClient) {
      receiverClient = null;
      console.log('[Cast] TV Receiver đã ngắt.');
      if (senderClient && senderClient.readyState === WebSocket.OPEN) {
        senderClient.send(JSON.stringify({ type: 'receiver_disconnected' }));
      }
    }
  });
});

// Khởi động server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`  LG TV WEB REMOTE CONTROL SERVER ĐANG CHẠY!`);
  console.log(`  Cổng lắng nghe: http://0.0.0.0:${PORT}`);
  console.log(`  Mở trên trình duyệt máy tính hoặc điện thoại:`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`====================================================`);
});
