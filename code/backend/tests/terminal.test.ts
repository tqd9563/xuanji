import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyColors,
  ghosttyComboToKeymap,
  globalKeybinds,
  parseKv,
  parseSymbolicHotkeys,
  pickThemeName,
  readGhostty,
  splitCommand,
  symbolicToKeymap,
} from '../src/adapters/ghostty.js';
import { defaultSpawnSpec, hasArm64Slice, isLocalRequest, parseLsofCwd, resolveCwd, shellEnv, TerminalManager, type TermServerMsg } from '../src/services/terminal.js';
import { sanitize } from '../src/services/prefs.js';

describe('Ghostty 配置解析', () => {
  it('parseKv:去注释、去引号、保留重复键', () => {
    const kv = parseKv('# c\nfont-family = "Maple Mono NF CN"\nkeybind = a=b\nkeybind = c=d\n\nbad line\n');
    expect(kv).toEqual([
      ['font-family', 'Maple Mono NF CN'],
      ['keybind', 'a=b'],
      ['keybind', 'c=d'],
    ]);
  });

  it('pickThemeName:明暗双主题取 dark', () => {
    expect(pickThemeName('Catppuccin Frappe')).toBe('Catppuccin Frappe');
    expect(pickThemeName('light:Catppuccin Latte,dark:Catppuccin Mocha')).toBe('Catppuccin Mocha');
    expect(pickThemeName(undefined)).toBeNull();
  });

  it('applyColors:palette 与前景/背景覆盖,非法值忽略', () => {
    const base = { name: 'x', background: '#000000', foreground: '#ffffff', cursor: '#ffffff', selection: '#333333', palette: Array(16).fill('#888888') };
    const t = applyColors(base, parseKv('palette = 1=#E78284\npalette = 16=#000000\nbackground = #303446\nforeground = nope'));
    expect(t.palette[1]).toBe('#e78284');
    expect(t.palette).toHaveLength(16);
    expect(t.background).toBe('#303446');
    expect(t.foreground).toBe('#ffffff');
  });

  it('只有 global: 前缀的绑定算全局热键,并归一成 keymap 串', () => {
    const kv = parseKv(
      'keybind = cmd+d=new_split:right\nkeybind = global:cmd+grave_accent=toggle_quick_terminal\nkeybind = global:ctrl+shift+space=x',
    );
    expect(globalKeybinds(kv)).toEqual(['mod+`', 'ctrl+shift+ ']);
    expect(ghosttyComboToKeymap('super+alt+k')).toBe('mod+alt+k');
    expect(ghosttyComboToKeymap('cmd+f13')).toBeNull();
  });

  it('readGhostty:读配置 + 用户主题目录,读不到配置返回 null', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-ghostty-'));
    expect(await readGhostty(home)).toBeNull();
    fs.mkdirSync(path.join(home, '.config/ghostty/themes'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.config/ghostty/themes/Mine'),
      'palette = 4=#8caaee\nbackground = #303446\nforeground = #c6d0f5\ncursor-color = #f2d5cf\n',
    );
    fs.writeFileSync(
      path.join(home, '.config/ghostty/config'),
      'theme = Mine\nfont-size = 14\nbackground-opacity = 0.9\nbackground-blur-radius = 30\ncursor-style = bar\nkeybind = global:cmd+grave_accent=toggle_quick_terminal\n',
    );
    const g = (await readGhostty(home))!;
    expect(g.theme?.name).toBe('Mine');
    expect(g.theme?.background).toBe('#303446');
    expect(g.theme?.palette[4]).toBe('#8caaee');
    expect(g).toMatchObject({ fontSize: 14, opacity: 90, blur: 30, cursorStyle: 'bar', cursorBlink: true, globalKeys: ['mod+`'] });
  });

  it('主题名不能穿越目录', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-ghostty-'));
    fs.mkdirSync(path.join(home, '.config/ghostty'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config/ghostty/config'), 'theme = ../../../../etc/hosts\n');
    expect((await readGhostty(home))!.theme).toBeNull();
  });
});

describe('macOS 系统快捷键', () => {
  it('[96, 50, 1048576] = ⌘`', () => {
    expect(symbolicToKeymap([96, 50, 1048576])).toBe('mod+`');
    expect(symbolicToKeymap([32, 49, 262144])).toBe('ctrl+ ');
    expect(symbolicToKeymap([65535, 50, 1048576])).toBeNull();
  });

  it('parseSymbolicHotkeys 带出启用状态,只收录认识的项', () => {
    const r = parseSymbolicHotkeys({
      '27': { enabled: false, value: { parameters: [96, 50, 1048576] } },
      '999': { enabled: true, value: { parameters: [97, 0, 1048576] } },
    });
    expect(r).toEqual([{ id: 27, name: '移动焦点到下一个窗口', combo: 'mod+`', enabled: false }]);
  });
});

describe('本机直连守卫', () => {
  const hdr = (h: Record<string, string>) => (n: string) => h[n];
  const ok = { host: 'localhost:7777', origin: 'http://localhost:7777' };

  it('本机浏览器直连放行(含 vite 预览的另一端口)', () => {
    expect(isLocalRequest('127.0.0.1', hdr(ok), true)).toBe(true);
    expect(isLocalRequest('::ffff:127.0.0.1', hdr({ host: 'localhost:37777', origin: 'http://localhost:35173' }), true)).toBe(true);
    expect(isLocalRequest('::1', hdr({ host: '[::1]:7777', origin: 'http://[::1]:7777' }), true)).toBe(true);
  });

  it('Tailscale serve 反代进来的一律拒:Host 是 ts.net 或带反代头', () => {
    expect(isLocalRequest('127.0.0.1', hdr({ host: 'mac.tail1234.ts.net', origin: 'https://mac.tail1234.ts.net' }))).toBe(false);
    expect(isLocalRequest('127.0.0.1', hdr({ ...ok, 'x-forwarded-for': '100.64.0.2' }))).toBe(false);
    expect(isLocalRequest('127.0.0.1', hdr({ ...ok, 'tailscale-user-login': 'a@b.c' }))).toBe(false);
  });

  it('任意网站跨域打过来的拒:Origin 不是回环', () => {
    expect(isLocalRequest('127.0.0.1', hdr({ host: 'localhost:7777', origin: 'https://evil.example' }))).toBe(false);
  });

  it('非回环对端拒;WS 不带 Origin 拒', () => {
    expect(isLocalRequest('192.168.1.5', hdr(ok))).toBe(false);
    expect(isLocalRequest('127.0.0.1', hdr({ host: 'localhost:7777' }), true)).toBe(false);
    expect(isLocalRequest('127.0.0.1', hdr({ host: 'localhost:7777' }))).toBe(true);
  });
});

describe('shell 环境', () => {
  it('补 TERM/COLORTERM/LANG,剥掉 claude 与璇玑注入的变量', () => {
    const env = shellEnv({ PATH: '/usr/bin', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk', XUANJI_DISPATCH: '1', FOO: 'x', npm_config_prefix: '/x', PNPM_SCRIPT_SRC_DIR: '/y', INIT_CWD: '/z' });
    expect(env).toMatchObject({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'zh_CN.UTF-8', FOO: 'x', PATH: '/usr/bin' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.XUANJI_DISPATCH).toBeUndefined();
    expect(env.npm_config_prefix).toBeUndefined();
    expect(env.PNPM_SCRIPT_SRC_DIR).toBeUndefined();
    expect(env.INIT_CWD).toBeUndefined();
  });

  it('已有 UTF-8 LANG 不覆盖', () => {
    expect(shellEnv({ LANG: 'en_US.UTF-8' }).LANG).toBe('en_US.UTF-8');
  });

  it('resolveCwd:展开 ~,不存在或相对路径回家目录', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-home-'));
    fs.mkdirSync(path.join(home, 'proj'));
    expect(resolveCwd('~/proj', home)).toBe(path.join(home, 'proj'));
    expect(resolveCwd('~/nope', home)).toBe(home);
    expect(resolveCwd('rel/path', home)).toBe(home);
    expect(resolveCwd(undefined, home)).toBe(home);
  });
});

describe('TerminalManager(真 pty)', () => {
  let mgr: TerminalManager | null = null;
  afterEach(() => {
    mgr?.killAll();
    mgr = null;
  });

  const collect = () => {
    const msgs: TermServerMsg[] = [];
    return { msgs, client: { send: (m: TermServerMsg) => msgs.push(m) }, text: () => msgs.map((m) => ('d' in m ? m.d : '')).join('') };
  };
  const waitFor = async (cond: () => boolean, ms = 4000) => {
    const t = Date.now();
    while (!cond()) {
      if (Date.now() - t > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('写入回显、重连回放、kill 后会话消失', async () => {
    mgr = new TerminalManager(() => ({ file: '/bin/bash', args: ['--norc', '--noprofile'], shell: '/bin/bash' }));
    const s = mgr.create({ cwd: os.tmpdir(), cols: 80, rows: 24 });
    const a = collect();
    mgr.attach(s.id, a.client);
    mgr.write(s.id, 'echo xj-$((40+2))\n');
    await waitFor(() => a.text().includes('xj-42'));
    const b = collect();
    mgr.attach(s.id, b.client);
    expect(b.msgs[0]).toMatchObject({ t: 'replay' });
    expect(b.text()).toContain('xj-42');
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.kill(s.id)).toBe(true);
    expect(mgr.list()).toHaveLength(0);
    expect(mgr.attach(s.id, collect().client)).toBeNull();
  });

  it('前台有命令在跑时状态转 busy,结束后回空闲', async () => {
    mgr = new TerminalManager(() => ({ file: '/bin/bash', args: ['--norc', '--noprofile'], shell: '/bin/bash' }));
    const s = mgr.create({});
    const a = collect();
    mgr.attach(s.id, a.client);
    mgr.write(s.id, 'sleep 2\n');
    await waitFor(() => a.msgs.some((m) => m.t === 'status' && m.busy && m.proc === 'sleep'));
    await waitFor(() => mgr!.get(s.id)?.busy === false, 5000);
  }, 10_000);

  it('cd 之后状态推送带上新目录(标签名跟着变)', async () => {
    mgr = new TerminalManager(() => ({ file: '/bin/bash', args: ['--norc', '--noprofile'], shell: '/bin/bash' }));
    const s = mgr.create({ cwd: os.homedir() });
    const a = collect();
    mgr.attach(s.id, a.client);
    const target = fs.realpathSync(os.tmpdir());
    mgr.write(s.id, `cd ${target}\n`);
    await waitFor(() => a.msgs.some((m) => m.t === 'status' && m.cwd === target), 6000);
    expect(mgr.get(s.id)?.cwd).toBe(target);
  }, 10_000);

  it('shell 退出时推 exit 并移除会话', async () => {
    mgr = new TerminalManager(() => ({ file: '/bin/bash', args: ['--norc', '--noprofile'], shell: '/bin/bash' }));
    const s = mgr.create({});
    const a = collect();
    mgr.attach(s.id, a.client);
    mgr.write(s.id, 'exit 3\n');
    await waitFor(() => a.msgs.some((m) => m.t === 'exit'));
    expect(a.msgs.find((m) => m.t === 'exit')).toMatchObject({ code: 3 });
    expect(mgr.get(s.id)).toBeNull();
  });
});

describe('账户偏好 · terminal', () => {
  it('默认跟随会话 + 保持;非法值回退', () => {
    expect(sanitize({}).terminal).toEqual({ cwdMode: 'session', navMode: 'keep' });
    expect(sanitize({ terminal: { cwdMode: 'home', navMode: 'bad' } }).terminal).toEqual({ cwdMode: 'home', navMode: 'keep' });
  });
});

describe('起 shell 的命令', () => {
  it('splitCommand 支持引号', () => {
    expect(splitCommand('/usr/bin/arch -arm64 /bin/zsh --login')).toEqual(['/usr/bin/arch', '-arm64', '/bin/zsh', '--login']);
    expect(splitCommand(`"/Applications/My Shell/fish" -l`)).toEqual(['/Applications/My Shell/fish', '-l']);
  });

  it('优先跟随 Ghostty command,shell 名取其中的 shell 路径', () => {
    expect(defaultSpawnSpec('/usr/bin/arch -arm64 /bin/zsh --login')).toEqual({
      file: '/usr/bin/arch',
      args: ['-arm64', '/bin/zsh', '--login'],
      shell: '/bin/zsh',
    });
  });

  it('Ghostty command 指向不存在的程序时回退登录 shell', () => {
    expect(defaultSpawnSpec('/no/such/shell -l').file).not.toBe('/no/such/shell');
  });

  it.runIf(process.platform === 'darwin')('只有 x86_64 切片的二进制不判为含 arm64(不会被强制 arch -arm64)', () => {
    expect(hasArm64Slice('/bin/zsh')).toBe(process.arch === 'arm64' || hasArm64Slice('/bin/zsh'));
    expect(hasArm64Slice('/no/such/bin')).toBe(false);
  });
});

describe('lsof cwd 解析', () => {
  it('p/n 成对解析多个进程,丢掉没有路径的', () => {
    expect([...parseLsofCwd('p101\nfcwd\nn/Users/u/xuanji\np202\nfcwd\nn/tmp\np303\n')]).toEqual([
      [101, '/Users/u/xuanji'],
      [202, '/tmp'],
    ]);
  });
});
