import { describe, expect, it } from 'vitest';

/**
 * 「换会话」的清理动作必须收在 Dispatch.tsx 的 leaveSession() 一处。
 *
 * 进入/离开一个会话有多条入口(看板接回 attach、/resume 续接、待办开工、无意图残留清理、
 * 交接 handoff、新建会话),每条都要把输入历史回溯范围与轮次索引(含尚未渲染、待回填的
 * 更早事件)一起归零。2026-09-09 实测:看板接回这条入口只清了输入历史,于是 lilith_offline_etl
 * 的会话打开轮次目录,前 40 条列的是上一个会话(baize/antifraud_skills)的轮次。
 * 这类「多入口漏一条」的缺陷在本项目已复发多次,故用测试钉住单点。
 *
 * 用 vite 的 `import.meta.glob` 取源码,不引 node:fs——前端 tsconfig 不含 node 类型。
 */
const FILES = import.meta.glob('../views/Dispatch.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const SRC = Object.values(FILES)[0] ?? '';

/** leaveSession() 函数体:从声明处到第一个单独成行的 `};` */
function leaveSessionBody(src: string): string {
  const start = src.indexOf('const leaveSession = () => {');
  if (start === -1) return '';
  const end = src.indexOf('\n  };', start);
  return end === -1 ? '' : src.slice(start, end);
}

/** 去掉注释行后统计某个调用出现的次数 */
function callSites(src: string, call: string): number {
  return src
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .filter((l) => l.includes(call)).length;
}

describe('换会话清理收在 leaveSession 一处', () => {
  it('Dispatch.tsx 里存在 leaveSession', () => {
    expect(SRC).toContain('const leaveSession = () => {');
  });

  it('leaveSession 同时归零输入历史与轮次索引', () => {
    const body = leaveSessionBody(SRC);
    expect(body).toContain('resetHistoryBrowse()');
    expect(body).toContain('resetTurnNav()');
    expect(body).toContain('setResumeInfo(null)');
    expect(body).toContain('setSessCtx(null)');
  });

  it('resetTurnNav 只在 leaveSession 里被调用(声明处除外)', () => {
    // 声明行 `const resetTurnNav = () => {` 不含 `resetTurnNav()`,故调用点应恰为 1 处
    expect(callSites(SRC, 'resetTurnNav()')).toBe(1);
    expect(leaveSessionBody(SRC)).toContain('resetTurnNav()');
  });

  it('resetHistoryBrowse 的调用点不超过发消息路径 + leaveSession', () => {
    // 发消息后回到「未在浏览」是它唯一的非换会话用途;新增换会话入口请走 leaveSession
    expect(callSites(SRC, 'resetHistoryBrowse()')).toBeLessThanOrEqual(2);
  });
});
