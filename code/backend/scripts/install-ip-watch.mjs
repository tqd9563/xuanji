#!/usr/bin/env node
/**
 * 安装/卸载 ip-watch 的 launchd 定时项(每 5 分钟一次 + 网络变化时触发)。
 *
 *   node scripts/install-ip-watch.mjs
 *   node scripts/install-ip-watch.mjs --uninstall
 *
 * 注意:该任务会在证书失配时重启后端,属宿主级操作,派发会话不得执行本脚本(防自斩铁律)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LABEL = 'com.xuanji.ip-watch';
const here = path.dirname(new URL(import.meta.url).pathname);
const script = path.join(here, 'ip-watch.sh');
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logDir = path.join(os.homedir(), '.xuanji');
const uid = process.getuid();
const target = `gui/${uid}/${LABEL}`;

const bootout = () => {
  try {
    execFileSync('launchctl', ['bootout', target], { stdio: 'ignore' });
  } catch {
    /* 未加载 */
  }
};

if (process.argv.includes('--uninstall')) {
  bootout();
  fs.rmSync(plistPath, { force: true });
  console.log(`已卸载 ${LABEL}`);
  process.exit(0);
}

if (!fs.existsSync(script)) {
  console.error(`未找到 ${script}`);
  process.exit(1);
}
fs.chmodSync(script, 0o755);
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(path.dirname(plistPath), { recursive: true });

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${esc(script)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'))}</string>
    <key>HOME</key><string>${esc(os.homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, 'ip-watch.out.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, 'ip-watch.err.log'))}</string>
</dict>
</plist>
`;

fs.writeFileSync(plistPath, plist);
bootout();
execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
console.log(`已安装 ${LABEL}(每 5 分钟检查一次办公网 IP)`);
console.log(`日志:${path.join(logDir, 'ip-watch.log')}`);
