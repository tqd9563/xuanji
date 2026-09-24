/**
 * 关闭会话:看板卡片 × 与系统监控弹窗「关闭会话以释放」共用这一处(文案与接口只有一份)。
 * 自有隐藏列表(~/.claude 不动);存活的 web 派发会话额外终止其进程。
 */
import { api } from '@/api/client';
import { confirmBox, toast } from '@/components/shared';

export interface CloseTarget {
  sessionId: string;
  name: string;
  /** 璇玑派发的会话:结束进程;否则只从看板隐藏 */
  dispatch: boolean;
}

export async function closeSession(s: CloseTarget, refresh?: () => void): Promise<boolean> {
  const msg = s.dispatch
    ? `结束派发会话「${s.name}」?\n其进程将被终止并从看板移除,已生成的记录仍可回放/续接。`
    : `从看板移除会话「${s.name}」?\n仅在璇玑隐藏,~/.claude 数据与终端不受影响。`;
  if (!(await confirmBox(msg))) return false;
  try {
    await api.closeSession(s.sessionId);
    toast(`已关闭 ${s.name}`);
    refresh?.();
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
    return false;
  }
}
