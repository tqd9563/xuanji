#!/usr/bin/env node
/**
 * launchd 常驻安装/卸载(macOS LaunchAgent):
 *   node scripts/install-launchd.mjs           # 生成 plist + 加载(开机自启 + 崩溃拉起)
 *   node scripts/install-launchd.mjs --uninstall
 *
 * plist 按本机环境生成(node 绝对路径、项目路径、含 claude CLI 的 PATH),不入库。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.xuanji.backend';
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logDir = path.join(os.homedir(), 'Library', 'Logs', 'xuanji');
const uid = process.getuid();

const launchctl = (args, ignoreFail = false) => {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' });
    return true;
  } catch (e) {
    if (!ignoreFail) throw e;
    return false;
  }
};

if (process.argv.includes('--uninstall')) {
  launchctl(['bootout', `gui/${uid}/${LABEL}`], true);
  fs.rmSync(plistPath, { force: true });
  console.log(`已卸载 ${LABEL}(plist 删除,服务停止)`);
  process.exit(0);
}

const nodeBin = process.execPath;
const tsxCli = path.join(backendDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!fs.existsSync(tsxCli)) {
  console.error('未找到 tsx,请先在 code/backend 执行 pnpm install');
  process.exit(1);
}

// launchd 不继承 shell PATH:显式带上 node、claude CLI 与系统路径(git 等)
const pathEnv = [
  path.dirname(nodeBin),
  path.join(os.homedir(), '.local', 'bin'), // claude CLI
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
].join(':');

fs.mkdirSync(logDir, { recursive: true });
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodeBin)}</string>
    <string>${esc(tsxCli)}</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(backendDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(pathEnv)}</string>
    <key>HOME</key><string>${esc(os.homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, 'backend.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, 'backend.err.log'))}</string>
</dict>
</plist>
`;

fs.writeFileSync(plistPath, plist);
launchctl(['bootout', `gui/${uid}/${LABEL}`], true); // 旧实例先退场
launchctl(['bootstrap', `gui/${uid}`, plistPath]);
console.log(`已安装并启动 ${LABEL}`);
console.log(`  plist: ${plistPath}`);
console.log(`  日志:  ${path.join(logDir, 'backend.log')}`);
console.log(`  服务:  http://127.0.0.1:7777(开机自启,崩溃 5s 内拉起)`);
