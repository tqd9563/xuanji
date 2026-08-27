/**
 * 验收面板服务用例:清单解析/实例化 + 真实子进程执行 + 自动收尾。
 *
 * 执行相关的用例**不打桩 spawn**——本功能的价值与风险都在「真的把进程拉起来、
 * 真的能收干净」,打桩等于把要验的东西验掉了。用 sh -c 造短命脚本来跑真进程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from '../src/storage/db.js';
import { parseRunbook, readRunbookFile } from '../src/adapters/runbook-file.js';
import {
  _resetRunbookState,
  instantiate,
  liveEnvironments,
  resolveRunbook,
  resolveSessionCleanup,
  runItem,
  stopItem,
  subscribeRunbook,
} from '../src/services/runbook.js';
import type { RunbookEvent } from '../src/services/runbook.js';
import type { RunbookItem, RunbookTemplate } from '../src/types.js';

let dir: string;
let storage: Storage;
const SID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xj-rb-'));
  storage = new Storage(path.join(dir, 'data'));
  fs.mkdirSync(path.join(dir, '.xuanji'), { recursive: true });
  _resetRunbookState();
});

afterEach(() => {
  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeRunbook = (obj: unknown) =>
  fs.writeFileSync(path.join(dir, '.xuanji', 'runbook.json'), JSON.stringify(obj));

const tpl = (items: RunbookItem[]): RunbookTemplate => ({
  id: 'tpl1',
  project: dir,
  name: '标准验收',
  version: 1,
  status: 'active',
  source: 'user',
  items,
  createdAt: 0,
  updatedAt: 0,
});

/** 等一个条件成立;比固定 sleep 稳,进程调度快慢都不会假失败 */
async function until(fn: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
}

describe('清单文件解析', () => {
  it('文件不存在 = 没有清单,不报 warning(退化路径是正常情况)', () => {
    const r = readRunbookFile(path.join(dir, 'nope'));
    expect(r.runbook).toBeNull();
    expect(r.warning).toBeUndefined();
  });

  it('坏 JSON 降级为没有清单并带原因,不抛', () => {
    fs.writeFileSync(path.join(dir, '.xuanji', 'runbook.json'), '{ not json');
    const r = readRunbookFile(dir);
    expect(r.runbook).toBeNull();
    expect(r.warning).toContain('解析失败');
  });

  it('拒绝不认识的 schemaVersion', () => {
    expect(parseRunbook({ schemaVersion: 99 }).runbook).toBeNull();
  });

  it('extraItems 的 origin 一律强制为 session(不信任文件里的自称)', () => {
    const r = parseRunbook({
      schemaVersion: 1,
      extraItems: [{ id: 'a', type: 'command', title: 'x', origin: 'template', command: 'ls' }],
    });
    expect(r.runbook?.extraItems?.[0]?.origin).toBe('session');
  });

  it('未知 type 降级为 command 而不是丢弃(schema 前向兼容)', () => {
    const r = parseRunbook({
      schemaVersion: 1,
      extraItems: [{ id: 'a', type: 'future-thing', title: 'x' }],
    });
    expect(r.runbook?.extraItems?.[0]?.type).toBe('command');
  });
});

describe('模板实例化', () => {
  const items: RunbookItem[] = [
    { id: 'stop', type: 'cleanup', title: '收尾', origin: 'template', command: 'true' },
    { id: 'env', type: 'service', title: '环境', origin: 'template', command: 'true' },
    { id: 'seed', type: 'command', title: '灌数', origin: 'template', command: 'true' },
  ];

  it('cleanup 恒沉到最底,不论模板里的位置', () => {
    const out = instantiate({ schemaVersion: 1 }, tpl(items));
    expect(out.map((i) => i.id)).toEqual(['env', 'seed', 'stop']);
  });

  it('omitItems 隐藏模板项,extraItems 追加在后', () => {
    const out = instantiate(
      {
        schemaVersion: 1,
        omitItems: ['seed'],
        extraItems: [{ id: 'req', type: 'request', title: '本次请求', origin: 'session' }],
      },
      tpl(items),
    );
    expect(out.map((i) => i.id)).toEqual(['env', 'req', 'stop']);
  });

  it('无模板时纯 extraItems 也能成清单', () => {
    const out = instantiate(
      { schemaVersion: 1, extraItems: [{ id: 'a', type: 'command', title: 'x', origin: 'session' }] },
      null,
    );
    expect(out).toHaveLength(1);
  });
});

describe('面板数据组装', () => {
  it('实例的 paramValues 覆盖模板 default(会话预填直接显示在表单里)', () => {
    storage.upsertRunbookTemplate(
      tpl([
        {
          id: 'seed',
          type: 'command',
          title: '灌数',
          origin: 'template',
          command: './seed.sh',
          params: [{ key: 'env', label: '数据源', type: 'enum', flag: '--env', default: 'dev' }],
        },
      ]),
    );
    writeRunbook({
      schemaVersion: 1,
      templateRef: { id: 'tpl1', version: 1 },
      paramValues: { seed: { env: 'prod' } },
    });
    const rb = resolveRunbook(storage, SID, dir);
    expect(rb?.items[0]?.params?.[0]?.default).toBe('prod');
  });

  it('黑名单命中的项带 blockedReason 下发(拦截前置到渲染时,不等点击才报错)', () => {
    storage.upsertRunbookTemplate(
      tpl([{ id: 'restart', type: 'command', title: '重启后端', origin: 'template', command: './restart.sh' }]),
    );
    writeRunbook({ schemaVersion: 1, templateRef: { id: 'tpl1', version: 1 } });
    const rb = resolveRunbook(storage, SID, dir);
    expect(rb?.items[0]?.blockedReason).toContain('防自斩');
  });

  it('没有清单文件时返回 null(面板不渲染)', () => {
    expect(resolveRunbook(storage, SID, path.join(dir, 'empty'))).toBeNull();
  });
});

describe('执行引擎(真实子进程)', () => {
  const cmdItem = (over: Partial<RunbookItem> = {}): RunbookItem => ({
    id: 'c1',
    type: 'command',
    title: '一次性命令',
    origin: 'template',
    command: `sh -c "echo hello-runbook"`,
    ...over,
  });

  it('跑完一次性命令,状态落 ok 并记下插值后的命令', async () => {
    const events: RunbookEvent[] = [];
    subscribeRunbook(SID, (e) => events.push(e));
    const r = runItem({ storage, sessionId: SID, cwd: dir, item: cmdItem() });
    expect(r.ok).toBe(true);

    await until(() => events.some((e) => e.ev === 'rb-state' && e.status === 'ok'));
    const run = storage.latestRunbookRuns(SID)[0]!;
    expect(run.status).toBe('ok');
    expect(run.exitCode).toBe(0);
    expect(run.resolvedCommand).toContain('echo hello-runbook');
    // 日志确实流回来了
    expect(events.filter((e) => e.ev === 'rb-log').map((e) => (e as { chunk: string }).chunk).join('')).toContain(
      'hello-runbook',
    );
  });

  it('非零退出码落 failed', async () => {
    const events: RunbookEvent[] = [];
    subscribeRunbook(SID, (e) => events.push(e));
    runItem({ storage, sessionId: SID, cwd: dir, item: cmdItem({ command: `sh -c "exit 3"` }) });
    await until(() => events.some((e) => e.ev === 'rb-state' && e.status === 'failed'));
    const run = storage.latestRunbookRuns(SID)[0]!;
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(3);
  });

  it('会话生成的项没带 confirmed 一律拒绝(后端才是边界,前端弹窗只是体验)', () => {
    const r = runItem({ storage, sessionId: SID, cwd: dir, item: cmdItem({ origin: 'session' }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('需确认');
    // 拒绝的执行不该留下运行记录
    expect(storage.latestRunbookRuns(SID)).toHaveLength(0);
  });

  it('带 confirmed 后放行', async () => {
    const r = runItem({ storage, sessionId: SID, cwd: dir, item: cmdItem({ origin: 'session' }), confirmed: true });
    expect(r.ok).toBe(true);
    await until(() => storage.latestRunbookRuns(SID)[0]?.status === 'ok');
  });

  it('黑名单项即便点了也执行不了', () => {
    const r = runItem({ storage, sessionId: SID, cwd: dir, item: cmdItem({ command: './restart.sh' }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('防自斩');
  });

  it('长驻 service 可停止,停止后从活跃列表消失', async () => {
    const svc: RunbookItem = {
      id: 's1',
      type: 'service',
      title: '长驻',
      origin: 'template',
      command: `sh -c "echo up; sleep 30"`,
    };
    runItem({ storage, sessionId: SID, cwd: dir, item: svc });
    expect(await until(() => liveEnvironments().length === 1)).toBe(true);

    const stopped = stopItem(storage, SID, 's1');
    expect(stopped.ok).toBe(true);
    expect(await until(() => liveEnvironments().length === 0)).toBe(true);
  });

  it('同一项重复启动被拒(不会起出两份环境)', async () => {
    const svc: RunbookItem = {
      id: 's1',
      type: 'service',
      title: '长驻',
      origin: 'template',
      command: `sh -c "sleep 30"`,
    };
    runItem({ storage, sessionId: SID, cwd: dir, item: svc });
    await until(() => liveEnvironments().length === 1);
    const again = runItem({ storage, sessionId: SID, cwd: dir, item: svc });
    expect(again.ok).toBe(false);
    stopItem(storage, SID, 's1');
  });
});

describe('验收通过的自动收尾', () => {
  it('先跑 cleanup 项、再停掉仍活着的 service', async () => {
    const marker = path.join(dir, 'cleaned.txt');
    storage.upsertRunbookTemplate(
      tpl([
        { id: 'env', type: 'service', title: '环境', origin: 'template', command: `sh -c "sleep 30"` },
        {
          id: 'stop',
          type: 'cleanup',
          title: '收尾',
          origin: 'template',
          command: `sh -c "echo done > ${marker}"`,
        },
      ]),
    );
    writeRunbook({ schemaVersion: 1, templateRef: { id: 'tpl1', version: 1 } });

    const rb = resolveRunbook(storage, SID, dir)!;
    runItem({ storage, sessionId: SID, cwd: dir, item: rb.items.find((i) => i.id === 'env')! });
    expect(await until(() => liveEnvironments().length === 1)).toBe(true);

    const done = await resolveSessionCleanup(storage, SID, dir);
    expect(done.length).toBeGreaterThan(0);
    // cleanup 脚本真的跑了
    expect(await until(() => fs.existsSync(marker))).toBe(true);
    // service 真的停了
    expect(await until(() => liveEnvironments().length === 0)).toBe(true);
  });

  it('没有清单的会话收尾时静默通过,不抛', async () => {
    await expect(resolveSessionCleanup(storage, SID, path.join(dir, 'empty'))).resolves.toEqual([]);
  });
});
