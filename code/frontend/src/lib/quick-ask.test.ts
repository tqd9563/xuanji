import { describe, expect, it } from 'vitest';

import { resolveCwd } from './quick-ask';

const QA = '/Users/me/scratch';
const P1 = '/Users/me/proj-a';
const P2 = '/Users/me/proj-b';

describe('resolveCwd', () => {
  it('未显式选目录时落在快速提问目录,并点亮标记', () => {
    const r = resolveCwd({ cwd: '', prefCwd: '', quickAskCwd: QA, projectPaths: [P1, P2] });
    expect(r.effectiveCwd).toBe(QA);
    expect(r.isQuickAsk).toBe(true);
  });

  it('快速提问目录不在项目扫描结果里时仍并入候选并置顶', () => {
    const r = resolveCwd({ cwd: '', prefCwd: '', quickAskCwd: QA, projectPaths: [P1] });
    expect(r.options).toEqual([QA, P1]);
  });

  it('快速提问目录已在项目列表里时不重复并入', () => {
    const r = resolveCwd({ cwd: '', prefCwd: '', quickAskCwd: QA, projectPaths: [QA, P1] });
    expect(r.options).toEqual([QA, P1]);
  });

  it('显式选了项目就用它,且标记熄灭', () => {
    const r = resolveCwd({ cwd: P1, prefCwd: '', quickAskCwd: QA, projectPaths: [P1, P2] });
    expect(r.effectiveCwd).toBe(P1);
    expect(r.isQuickAsk).toBe(false);
  });

  it('设了默认工作目录时它压过快速提问目录', () => {
    const r = resolveCwd({ cwd: '', prefCwd: P2, quickAskCwd: QA, projectPaths: [P1, P2] });
    expect(r.effectiveCwd).toBe(P2);
    expect(r.isQuickAsk).toBe(false);
  });

  it('默认工作目录已不在候选里时被跳过,退回快速提问目录', () => {
    const r = resolveCwd({ cwd: '', prefCwd: '/Users/me/gone', quickAskCwd: QA, projectPaths: [P1] });
    expect(r.effectiveCwd).toBe(QA);
    expect(r.isQuickAsk).toBe(true);
  });

  it('关闭快速提问(留空)时退回候选首项,标记不出现', () => {
    const r = resolveCwd({ cwd: '', prefCwd: '', quickAskCwd: '', projectPaths: [P1, P2] });
    expect(r.effectiveCwd).toBe(P1);
    expect(r.isQuickAsk).toBe(false);
    expect(r.options).toEqual([P1, P2]);
  });

  it('显式切回快速提问目录同样点亮标记(标记只认路径,不认怎么来的)', () => {
    const r = resolveCwd({ cwd: QA, prefCwd: P1, quickAskCwd: QA, projectPaths: [P1] });
    expect(r.isQuickAsk).toBe(true);
  });

  it('什么都没有时给空串,不崩', () => {
    const r = resolveCwd({ cwd: '', prefCwd: '', quickAskCwd: '', projectPaths: [] });
    expect(r.effectiveCwd).toBe('');
    expect(r.isQuickAsk).toBe(false);
  });
});
