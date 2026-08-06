#!/usr/bin/env node
/**
 * 把「访问地址变了」这件事送到用户手上。
 *
 * 办公笔记本的 macOS 横幅在人不在工位时等于没发,所以主通道是 webhook(飞书自定义机器人 /
 * Discord webhook 都是一个 POST):在 ~/.xuanji/remote.env 配 XUANJI_NOTIFY_WEBHOOK 即可。
 * 未配置时退回 macOS 横幅 + 落盘日志,保证至少回到工位能看到。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const message = process.argv.slice(2).join(' ').trim();
if (!message) process.exit(0);

const stateDir = process.env.XUANJI_STATE_DIR ?? path.join(os.homedir(), '.xuanji');
const envFile = process.env.XUANJI_ENV_FILE ?? path.join(stateDir, 'remote.env');

/** 只读需要的两个键,避免把整份密钥读进内存 */
function readEnv(key) {
  if (process.env[key]) return process.env[key];
  try {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i > 0 && s.slice(0, i).trim() === key) return s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* 文件不存在 = 未配置 */
  }
  return '';
}

fs.mkdirSync(stateDir, { recursive: true });
fs.appendFileSync(path.join(stateDir, 'ip-watch.log'), `${new Date().toISOString()} ${message}\n`);

const webhook = readEnv('XUANJI_NOTIFY_WEBHOOK');
if (webhook) {
  // 飞书自定义机器人与 Discord webhook 的最简载荷字段不同,两个都带上,谁认哪个是哪个
  const payload = { msg_type: 'text', content: { text: message }, content_type: 'text', text: message };
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) process.exit(0);
    console.error(`[notify] webhook 返回 ${res.status}`);
  } catch (e) {
    console.error(`[notify] webhook 失败:${e.message}`);
  }
}

if (process.platform === 'darwin') {
  const esc = (s) => s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').slice(0, 200);
  execFile('osascript', ['-e', `display notification "${esc(message)}" with title "璇玑"`], { timeout: 5000 }, () => {});
}
