/** 移动端底部拇指区导航(≤430px 现身,桌面隐藏,见 index.css)。
 *  5 个 tab:首页/会话/派发/定时 直接映射主视图;「更多」聚合 项目/技能/经验/回顾——
 *  这四个次要视图在桌面是并列侧栏项,移动端信息架构改为二级菜单(见 MoreMenu)。 */
import type { ViewId } from '@/lib/hooks';

export type MobileTab = 'dashboard' | 'sessions' | 'dispatch' | 'cron' | 'more';

const TABS: { id: MobileTab; label: string; icon: string }[] = [
  { id: 'dashboard', label: '首页', icon: 'M3 11.5 12 4l9 7.5 M5 10v10h14V10' },
  { id: 'sessions', label: '会话', icon: 'M3 4h18v6H3z M3 14h18v6H3z' },
  { id: 'dispatch', label: '派发', icon: 'M22 2 11 13 M22 2 15 22l-4-9-9-4z' },
  { id: 'cron', label: '定时', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3.5 2' },
  { id: 'more', label: '更多', icon: 'M5 12a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z M12 12a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z M19 12a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z' },
];

/** 桌面 ViewId → 所属移动端 tab(次要视图统一归入「更多」) */
export function mobileTabOf(view: ViewId, mobileMore: boolean): MobileTab {
  if (mobileMore) return 'more';
  if (view === 'dashboard' || view === 'sessions' || view === 'dispatch' || view === 'cron') return view;
  return 'more';
}

export function TabBar({
  active,
  blockedCount,
  onPick,
}: {
  active: MobileTab;
  blockedCount: number;
  onPick: (tab: MobileTab) => void;
}) {
  return (
    <nav className="tabbar">
      {TABS.map((t) => (
        <button key={t.id} className={active === t.id ? 'active' : ''} onClick={() => onPick(t.id)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d={t.icon} />
          </svg>
          <span>{t.label}</span>
          {t.id === 'sessions' && blockedCount > 0 && <span className="bdg">{blockedCount}</span>}
        </button>
      ))}
    </nav>
  );
}
