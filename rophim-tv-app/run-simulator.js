const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const rawAppDir = path.resolve(__dirname);
const APP_DIR = rawAppDir.charAt(0).toUpperCase() + rawAppDir.slice(1);
const SIM_DIR = path.join(ROOT_DIR, 'simulator', 'webOS_TV_6.0_Simulator_1.4.1');

function cleanSimulatorEntries() {
  try {
    const cfgPath = path.join(process.env.APPDATA || '', 'webOS TV 6.0 Simulator', 'webos-tv-simulator-6.0.json');
    if (!fs.existsSync(cfgPath)) return;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg && cfg.internal && Array.isArray(cfg.internal.appEntries)) {
      const seen = new Set();
      const deduped = [];
      for (const entry of cfg.internal.appEntries) {
        const norm = entry.charAt(0).toUpperCase() + entry.slice(1);
        if (!seen.has(norm.toLowerCase())) {
          seen.add(norm.toLowerCase());
          deduped.push(norm);
        }
      }
      if (!seen.has(APP_DIR.toLowerCase())) {
        deduped.push(APP_DIR);
      }
      cfg.internal.appEntries = deduped;
    }
    if (cfg && cfg.settings) {
      cfg.settings['auto-inspector'] = false;
      if (cfg.settings['screen-saver']) cfg.settings['screen-saver'].isOn = false;
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, '\t'), 'utf8');
  } catch (e) {}
}

function main() {
  try {
    execSync('taskkill /F /IM "webOS_TV_6.0_Simulator*" >nul 2>&1');
  } catch (e) {}

  cleanSimulatorEntries();

  // Start RoPhim Proxy + AdBlocker server on port 5020 in-process
  require('./server.js');

  const exePath = path.join(SIM_DIR, 'webOS_TV_6.0_Simulator_1.4.1.exe');
  if (!fs.existsSync(exePath)) {
    console.error('Không tìm thấy webOS_TV_6.0_Simulator_1.4.1.exe tại:', exePath);
    process.exit(1);
  }

  console.log('[Launch] Đang mở RoPhim TV trên webOS TV 6.0 Simulator...');
  const child = spawn(exePath, [APP_DIR], {
    cwd: SIM_DIR,
    detached: true,
    windowsHide: false,
    stdio: 'ignore'
  });
  child.unref();
  console.log('==============================================================');
  console.log('  RoPhim TV + AdBlocker đã mở trên webOS TV 6.0 Simulator!');
  console.log('  Giữ cửa sổ này mở để Proxy Server & Bộ chặn QC hoạt động.');
  console.log('==============================================================');
}

main();
