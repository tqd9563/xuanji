/**
 * 执行守卫用例。这是验收面板唯一的安全边界,故按「攻击面」而不是「函数」组织:
 * 每个 describe 对应一类想混进来的东西。
 */
import { describe, expect, it } from 'vitest';
import {
  checkBlacklist,
  guardItem,
  resolveCommand,
  resolveCwd,
  tokenize,
} from '../src/services/runbook-guard.js';
import type { RunbookItem } from '../src/types.js';

const item = (over: Partial<RunbookItem>): RunbookItem => ({
  id: 'x',
  type: 'command',
  title: 't',
  origin: 'template',
  ...over,
});

describe('防自斩黑名单', () => {
  it('拦下 restart.sh 的各种写法', () => {
    for (const cmd of ['./restart.sh', 'restart.sh', 'bash ./restart.sh', 'cd /x && ./restart.sh']) {
      expect(checkBlacklist(cmd).ok, cmd).toBe(false);
    }
  });

  it('拦下 launchctl 与 launchd 服务操作', () => {
    expect(checkBlacklist('launchctl kickstart -k gui/501/com.xuanji.backend').ok).toBe(false);
    expect(checkBlacklist('launchctl bootout gui/501/com.xuanji.backend').ok).toBe(false);
    expect(checkBlacklist('pnpm launchd:install').ok).toBe(false);
  });

  it('拦下杀 :7777 宿主后端的写法', () => {
    expect(checkBlacklist('lsof -ti:7777 | xargs kill -9').ok).toBe(false);
    expect(checkBlacklist('kill -9 $(lsof -t -i:7777)').ok).toBe(false);
  });

  it('不误伤正常的验收命令', () => {
    for (const cmd of [
      './scripts/local_test.sh --env prod',
      './preview.sh --keep-db',
      'make serve',
      './preview.sh --stop',
      // 端口号里含 777 但不是 7777,不该命中
      'kill -9 $(lsof -t -i:37777)',
    ]) {
      expect(checkBlacklist(cmd).ok, cmd).toBe(true);
    }
  });

  it('模板来源的项同样受黑名单约束(防模板起草时夹带)', () => {
    const r = guardItem(item({ origin: 'template', command: './restart.sh' }), '/tmp/wt');
    expect(r.ok).toBe(false);
  });
});

describe('cwd 围栏', () => {
  it('允许会话目录内的相对路径', () => {
    const r = resolveCwd('/tmp/wt', 'code/backend');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cwd).toBe('/tmp/wt/code/backend');
  });

  it('缺省 cwd 落在会话根', () => {
    const r = resolveCwd('/tmp/wt');
    expect(r.ok && r.cwd).toBe('/tmp/wt');
  });

  it('拒绝 ../ 逃逸与指向别处的绝对路径', () => {
    expect(resolveCwd('/tmp/wt', '../other').ok).toBe(false);
    expect(resolveCwd('/tmp/wt', '../../etc').ok).toBe(false);
    expect(resolveCwd('/tmp/wt', '/etc').ok).toBe(false);
  });
});

describe('参数插值与 shell 注入', () => {
  it('flag 参数按声明顺序追加', () => {
    const it0 = item({
      command: './scripts/local_seed.sh',
      params: [
        { key: 'env', label: '数据源', type: 'enum', flag: '--env', default: 'prod' },
        { key: 'start', label: '开始', type: 'date', flag: '--start', default: '2026-08-20' },
      ],
    });
    expect(resolveCommand(it0).display).toBe('./scripts/local_seed.sh --env prod --start 2026-08-20');
  });

  it('用户输入覆盖预填', () => {
    const it0 = item({
      command: './s.sh',
      params: [{ key: 'env', label: 'e', type: 'enum', flag: '--env', default: 'prod' }],
    });
    expect(resolveCommand(it0, { env: 'dev' }).display).toBe('./s.sh --env dev');
  });

  it('boolean 只在为真时追加 flag,不追加值', () => {
    const it0 = item({
      command: './preview.sh',
      params: [{ key: 'keepdb', label: 'k', type: 'boolean', flag: '--keep-db' }],
    });
    expect(resolveCommand(it0, { keepdb: 'false' }).display).toBe('./preview.sh');
    expect(resolveCommand(it0, { keepdb: 'true' }).display).toBe('./preview.sh --keep-db');
  });

  it('{{key}} 占位符走原地插值,不再追加', () => {
    const it0 = item({
      command: './s.sh --at {{day}} tail',
      params: [{ key: 'day', label: 'd', type: 'date', flag: '--day', default: '2026-08-20' }],
    });
    expect(resolveCommand(it0).display).toBe('./s.sh --at 2026-08-20 tail');
  });

  it('参数值里的 shell 元字符不产生额外 argv,只是一个普通实参', () => {
    const it0 = item({
      command: './s.sh',
      params: [{ key: 'note', label: 'n', type: 'string', flag: '--note' }],
    });
    const r = resolveCommand(it0, { note: '; rm -rf / #' });
    // 关键:注入串整体是一个 argv,没有被切成 `;` `rm` `-rf` `/`
    expect(r.argv).toEqual(['./s.sh', '--note', '; rm -rf / #']);
  });

  it('注入串不会绕过黑名单(插值后才判定)', () => {
    const it0 = item({
      command: './s.sh',
      params: [{ key: 'x', label: 'x', type: 'string', flag: '--x' }],
    });
    const r = guardItem(it0, '/tmp/wt', { x: '&& ./restart.sh' });
    expect(r.ok).toBe(false);
  });
});

describe('tokenize', () => {
  it('按空白切分并尊重引号包裹', () => {
    expect(tokenize('make serve')).toEqual(['make', 'serve']);
    expect(tokenize(`./s.sh --msg "hello world"`)).toEqual(['./s.sh', '--msg', 'hello world']);
    expect(tokenize(`./s.sh --msg 'a b'`)).toEqual(['./s.sh', '--msg', 'a b']);
  });

  it('保留空字符串实参(引号包裹的空值)', () => {
    expect(tokenize(`./s.sh --msg ""`)).toEqual(['./s.sh', '--msg', '']);
  });
});
