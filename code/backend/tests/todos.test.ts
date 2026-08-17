import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage/db.js';
import { isTodoStatus, shortName, statusPatch, validateTitle, TITLE_MAX } from '../src/services/todos.js';
import { syncTodosWithBoard } from '../src/services/sessions.js';
import type { AgentSession, SessionState } from '../src/types.js';

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanji-todo-'));
  storage = new Storage(dir);
});

afterEach(() => {
  storage.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('待办存储', () => {
  it('新建即 open 态,时间戳只落 createdAt', () => {
    const t = storage.createTodo({ title: '给派发页加 rate-limit 通知', cwd: '/Users/x/xuanji', project: 'xuanji', source: 'web' });
    expect(t.status).toBe('open');
    expect(t.project).toBe('xuanji');
    expect(t.startedAt).toBeNull();
    expect(t.doneAt).toBeNull();
    expect(t.createdAt).toBeGreaterThan(0);
  });

  it('未指定项目时 cwd/project 均为 null(不阻塞记录)', () => {
    const t = storage.createTodo({ title: '想到再说', source: 'external' });
    expect(t.cwd).toBeNull();
    expect(t.project).toBeNull();
    expect(t.source).toBe('external');
  });

  it('列表按新建倒序:刚记的在最上面', () => {
    storage.createTodo({ title: '第一条', source: 'web' });
    storage.createTodo({ title: '第二条', source: 'web' });
    expect(storage.listTodos().map((t) => t.title)).toEqual(['第二条', '第一条']);
  });

  it('开工绑定会话:状态转 doing 并挂上 sessionId', () => {
    const t = storage.createTodo({ title: '开工试试', source: 'web' });
    storage.updateTodo(t.id, { ...statusPatch('doing'), sessionId: 'abc-123' });
    const after = storage.getTodo(t.id)!;
    expect(after.status).toBe('doing');
    expect(after.sessionId).toBe('abc-123');
    expect(after.startedAt).toBeGreaterThan(0);
  });

  it('删除后查不到', () => {
    const t = storage.createTodo({ title: '记错了', source: 'web' });
    storage.deleteTodo(t.id);
    expect(storage.getTodo(t.id)).toBeNull();
  });
});

describe('状态流转的时间戳', () => {
  it('done 记 doneAt', () => {
    const p = statusPatch('done');
    expect(p.status).toBe('done');
    expect(p.doneAt).toBeGreaterThan(0);
  });

  it('doing 记 startedAt 并清空 doneAt(从已完成回退再开工)', () => {
    const p = statusPatch('doing');
    expect(p.startedAt).toBeGreaterThan(0);
    expect(p.doneAt).toBeNull();
  });

  it('回退 open 清空两个时间戳(等于重新开始)', () => {
    const p = statusPatch('open');
    expect(p.startedAt).toBeNull();
    expect(p.doneAt).toBeNull();
  });
});

describe('入参校验', () => {
  it('空标题与纯空白拒绝', () => {
    expect(validateTitle('')).not.toBeNull();
    expect(validateTitle('   ')).not.toBeNull();
    expect(validateTitle(undefined)).not.toBeNull();
    expect(validateTitle(123)).not.toBeNull();
  });

  it('超长标题拒绝,边界内放行', () => {
    expect(validateTitle('x'.repeat(TITLE_MAX))).toBeNull();
    expect(validateTitle('x'.repeat(TITLE_MAX + 1))).not.toBeNull();
  });

  it('status 只认三态', () => {
    expect(isTodoStatus('open')).toBe(true);
    expect(isTodoStatus('doing')).toBe(true);
    expect(isTodoStatus('done')).toBe(true);
    expect(isTodoStatus('archived')).toBe(false);
  });

  it('短名取路径末段,尾斜杠不影响', () => {
    expect(shortName('/Users/x/work/baize')).toBe('baize');
    expect(shortName('/Users/x/work/baize/')).toBe('baize');
  });
});

describe('看板同步自动完成(syncTodosWithBoard)', () => {
  const card = (sessionId: string, state: SessionState): AgentSession =>
    ({ id: sessionId.slice(0, 8), sessionId, name: sessionId, cwd: '/tmp/p', project: 'p', kind: 'background', state, startedAt: 1, readonly: false, source: 'web' }) as AgentSession;
  const cols = (fill?: Partial<Record<SessionState, AgentSession[]>>): Record<SessionState, AgentSession[]> =>
    ({ idle: [], running: [], blocked: [], review: [], done: [], ...fill });

  const startDoing = (sessionId: string) => {
    const t = storage.createTodo({ title: `任务-${sessionId}`, source: 'web' });
    storage.updateTodo(t.id, { ...statusPatch('doing'), sessionId });
    return t.id;
  };

  it('会话进 done 列 → 进行中的待办自动转已完成', () => {
    const id = startDoing('s-done');
    syncTodosWithBoard(cols({ done: [card('s-done', 'done')] }), true, storage);
    const t = storage.getTodo(id)!;
    expect(t.status).toBe('done');
    expect(t.doneAt).toBeGreaterThan(0);
  });

  it('会话从看板彻底消失 → 同样自动完成', () => {
    const id = startDoing('s-gone');
    syncTodosWithBoard(cols(), true, storage);
    expect(storage.getTodo(id)!.status).toBe('done');
  });

  it('会话仍在 running/review 等活跃列 → 待办不动', () => {
    const a = startDoing('s-run');
    const b = startDoing('s-review');
    syncTodosWithBoard(cols({ running: [card('s-run', 'running')], review: [card('s-review', 'review')] }), true, storage);
    expect(storage.getTodo(a)!.status).toBe('doing');
    expect(storage.getTodo(b)!.status).toBe('doing');
  });

  it('agents CLI 失败(ok=false)时整轮跳过,防「消失」误判', () => {
    const id = startDoing('s-cli-down');
    syncTodosWithBoard(cols(), false, storage);
    expect(storage.getTodo(id)!.status).toBe('doing');
  });

  it('open/done 待办与未挂会话的 doing 待办不受影响', () => {
    const open = storage.createTodo({ title: '还没开工', source: 'web' });
    const noSession = storage.createTodo({ title: '开工但没发过消息', source: 'web' });
    storage.updateTodo(noSession.id, statusPatch('doing'));
    syncTodosWithBoard(cols(), true, storage);
    expect(storage.getTodo(open.id)!.status).toBe('open');
    expect(storage.getTodo(noSession.id)!.status).toBe('doing');
  });
});
