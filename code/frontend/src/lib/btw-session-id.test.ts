import { describe, expect, it } from 'vitest';

/**
 * 旁路记录按会话挂载在璇玑自有库里,拉取时机是本 bug 的全部内容:
 * 2026-09-16 实测,后端重启后续接老会话,面板显示「这个会话还没有旁路记录」——
 * 记录一条没少(库里 46 条都在、接口 200),只是拉取挂在 `sessionId` 上,
 * 而 `sessionId` 要等 SDK 的 init 事件,init 又要等你发出续接后的第一条消息。
 *
 * 修法是让进入会话的入口先登记已知 id(`noteSessionId`)。这类「某条入口漏做该做的事」
 * 在本项目已复发多次,所以用扫源码的守卫钉住两端:拉取端认已知 id,入口端登记。
 */
const FILES = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

function src(suffix: string): string {
  const hit = Object.entries(FILES).find(([p]) => p.endsWith(suffix));
  if (!hit) throw new Error(`找不到源文件 ${suffix}`);
  return hit[1];
}

describe('旁路记录的会话 id 来源', () => {
  it('拉取用的是「init 的 id ?? 入口登记的已知 id」,不是裸 sessionId', () => {
    const s = src('/dispatch.ts');
    expect(s).toContain('const btwSessionId = sessionId ?? knownSessionId;');
    expect(s).toContain('.sideQuestions(btwSessionId)');
    // 修复前这里是 `}, [sessionId]);`,只随 init 变化
    expect(s).toContain('}, [btwSessionId]);');
  });

  it('离开会话会把已知 id 归零,避免漏进下一个会话', () => {
    expect(src('views/Dispatch.tsx')).toMatch(/const leaveSession = \(\) => \{[\s\S]*?d\.noteSessionId\(null\)[\s\S]*?\n  \};/);
  });

  it('续接与接回两条入口都登记了自己的会话 id', () => {
    const s = src('views/Dispatch.tsx');
    expect(s).toContain('d.noteSessionId(info.sessionId)'); // applyResume:/resume 弹窗与看板续接意图共用
    expect(s).toContain('d.noteSessionId(intent.attach.sessionId)'); // 看板接回存活会话
  });
});
