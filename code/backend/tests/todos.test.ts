import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../src/storage/db.js';
import { isTodoStatus, shortName, statusPatch, validateTitle, TITLE_MAX } from '../src/services/todos.js';

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
