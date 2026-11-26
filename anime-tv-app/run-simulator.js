const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const rawAppDir = path.resolve(__dirname);
const APP_DIR = rawAppDir.charAt(0).toUpperCase() + rawAppDir.slice(1);
const SIM_ROOT = path.join(ROOT_DIR, 'simulator');
const ZIP_PATH = path.join(SIM_ROOT, 'webOS_TV_6.0_Simulator_1.4.1_win.zip');

function cleanSimulatorDuplicateEntries() {
  try {
    const cfgPath = path.join(process.env.APPDATA || '', 'webOS TV 6.0 Simulator', 'webos-tv-simulator-6.0.json');
    if (!fs.existsSync(cfgPath)) return;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg && cfg.internal && Array.isArray(cfg.internal.appEntries)) {
      const seen = new Set();
      const deduped = [];
      for (const entry of cfg.internal.appEntries) {
        const norm = entry.charAt(0).toUpperCase() + entry.slice(1);
        const key = norm.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(norm);
        }
      }
      cfg.internal.appEntries = deduped;
    }
    if (cfg && cfg.settings) {
      cfg.settings['auto-inspector'] = false;
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, '\t'), 'utf8');
  } catch (e) {}
}

function findSimulatorFolder() {
  if (!fs.existsSync(SIM_ROOT)) return null;
  const entries = fs.readdirSync(SIM_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.toLowerCase().includes('simulator')) {
      return path.join(SIM_ROOT, entry.name);
    }
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) {
      return SIM_ROOT;
    }
  }
  return null;
}

async function ensureSimulatorInstalled() {
  let simDir = findSimulatorFolder();
  if (simDir) {
    console.log('[Simulator] Đã tìm thấy bộ cài tại:', simDir);
    return simDir;
  }

  fs.mkdirSync(SIM_ROOT, { recursive: true });

  if (!fs.existsSync(ZIP_PATH)) {
    console.log('[1/3] Đang lấy link tải chính thức từ LG Developer (webOS TV 6.0 Simulator)...');
    const encRes = await fetch('https://webostv.developer.lge.com/api/downloadSDK', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: 'RF00021083' })
    });
    if (!encRes.ok) throw new Error('Không lấy được fileIdEnc: ' + encRes.status);
    const { fileIdEnc } = await encRes.json();

    const xmlRes = await fetch(
      'https://developer.lge.com/common/file/DownloadFilePath.ajax?fileId=' + encodeURIComponent(fileIdEnc),
      {
        method: 'POST',
        headers: {
          'Referer': 'https://webostv.developer.lge.com/',
          'Origin': 'https://webostv.developer.lge.com'
        }
      }
    );
    const xml = await xmlRes.text();
    const match = xml.match(/gftsUrl="([^"]+)"/);
    if (!match) throw new Error('Không tìm thấy gftsUrl từ LG Server: ' + xml);
    const downloadUrl = match[1].replace(/&amp;/g, '&').trim();

    console.log('[2/3] Đang tải webOS_TV_6.0_Simulator_1.4.1_win.zip (~55 MB)...');
    const dlRes = await fetch(downloadUrl);
    if (!dlRes.ok) throw new Error('Tải thất bại: HTTP ' + dlRes.status);
    const buf = Buffer.from(await dlRes.arrayBuffer());
    fs.writeFileSync(ZIP_PATH, buf);
    console.log('      Đã tải xong (' + (buf.length / 1024 / 1024).toFixed(2) + ' MB).');
  }

  console.log('[3/3] Đang giải nén webOS TV 6.0 Simulator...');
  execSync(`tar -xf "${ZIP_PATH}" -C "${SIM_ROOT}"`, { stdio: 'inherit' });
  try {
    fs.unlinkSync(ZIP_PATH);
  } catch (e) {}

  simDir = findSimulatorFolder();
  if (!simDir) throw new Error('Không tìm thấy thư mục Simulator sau khi giải nén.');
  console.log('[Simulator] Giải nén hoàn tất tại:', simDir);
  return simDir;
}

async function main() {
  const simDir = await ensureSimulatorInstalled();

  // Dọn tiến trình Simulator chạy ngầm cũ (nếu có) để tránh bị khóa Single-Instance của Electron
  try {
    execSync('taskkill /F /IM "webOS_TV_6.0_Simulator*" >nul 2>&1');
  } catch (e) {}

  cleanSimulatorDuplicateEntries();

  // Khởi chạy Proxy Server ngay trong tiến trình này
  require('./server.js');

  const exePath = path.join(simDir, 'webOS_TV_6.0_Simulator_1.4.1.exe');
  console.log('[Launch] Đang mở cửa sổ webOS TV 6.0 Simulator...');
  const child = spawn(exePath, [APP_DIR], {
    cwd: simDir,
    detached: true,
    windowsHide: false,
    stdio: 'ignore'
  });
  child.unref();
  console.log('==============================================================');
  console.log('  Đã mở webOS TV 6.0 Simulator! (Đợi ~3-5 giây cửa sổ hiện lên)');
  console.log('  Giữ cửa sổ đen này mở để Proxy Server phát video cho TV.');
  console.log('==============================================================');
}

main().catch((err) => {
  console.error('Lỗi:', err.message);
  process.exit(1);
});
