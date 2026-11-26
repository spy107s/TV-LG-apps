'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const appDir = __dirname;
const simExe = path.resolve(__dirname, '..', 'simulator', 'webOS_TV_6.0_Simulator_1.4.1', 'webOS_TV_6.0_Simulator_1.4.1.exe');

// 1. Start local TikTok TV proxy on 127.0.0.1:5070
require('./server');

// 2. Launch webOS TV 6.0 Simulator if available
if (fs.existsSync(simExe)) {
  console.log('[SIM] Launching webOS TV 6.0 Simulator for TikTok TV...');
  const child = spawn(simExe, [appDir], { detached: true, stdio: 'ignore' });
  child.unref();
} else {
  console.log('[SIM] Simulator exe not found. Open http://127.0.0.1:5070 in browser to preview.');
}
