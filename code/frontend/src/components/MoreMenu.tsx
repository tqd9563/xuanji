/** 移动端「更多」聚合菜单:项目/技能/经验/回顾在桌面是并列侧栏项,窄屏收进二级菜单
 *  (DESIGN.md「移动端(≤430px)」:导航沉底为 5-tab,四个次要视图归入更多)。
 *  usePoll 的 fetcher 引用与各自视图相同,命中 pollCache,不重复拉取。 */
import { api } from '@/api/client';
import { usePoll } from '@/lib/hooks';
import type { ViewId } from '@/lib/hooks';

const ICONS: Record<string, string> = {
  projects: 'M3 7l3-4h5l2 3h8v13H3z',
  skills: 'M12 2l2.6 6.6L21 11l-6.4 2.4L12 20l-2.6-6.6L3 11l6.4-2.4z',
  memory: 'M5 3h11l3 3v15H5zM9 8h7M9 12h7M9 16h4',
  review: 'M4 5h16v16H4zM4 9.5h16M8.5 3v4M15.5 3v4M8 14l2.5 2.5L16 12',
  wallpaper: 'M2 4h20v16H2zM8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM3 18l5.5-5.5 3.5 3.5 4.5-5 4.5 5.5',
};

function Row({ id, label, hint, onClick }: { id: keyof typeof ICONS; label: string; hint?: string; onClick: () => void }) {
  return (
    <button className="more-row" onClick={onClick}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d={ICONS[id]} />
      </svg>
      <span className="lbl">{label}</span>
      {hint && <span className="hint-v">{hint}</span>}
      <span className="chev">›</span>
    </button>
  );
}

export function MoreMenu({ onNav, health }: { onNav: (v: ViewId) => void; health: { cli: string | null } | null }) {
  const { data: projectsData } = usePoll(api.projects, 60_000);
  const { data: skillsData } = usePoll(api.skills, 60_000);
  const { data: memData } = usePoll(api.memories, 60_000);

  const skillsOn = skillsData?.skills.filter((s) => s.enabled).length;

  return (
    <>
      <div className="view-head">
        <h1>更多</h1>
      </div>
      <div className="more-list">
        <Row id="projects" label="项目" hint={projectsData ? `${projectsData.projects.length} 个` : undefined} onClick={() => onNav('projects')} />
        <Row id="skills" label="技能" hint={skillsData ? `${skillsOn} 启用 · ${skillsData.skills.length} 共` : undefined} onClick={() => onNav('skills')} />
        <Row id="memory" label="经验" hint={memData ? `${memData.memories.length} 条` : undefined} onClick={() => onNav('memory')} />
        <Row id="review" label="回顾" onClick={() => onNav('review')} />
      </div>
      <div className="more-foot">
        <div>
          <span className="ok" style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: health?.cli ? 'var(--jade)' : 'var(--red)', marginRight: 5, verticalAlign: 1 }} />
          {health === null ? '连接后端…' : health.cli ? `${health.cli} · 就绪` : '后端可用 · CLI 不可达'}
        </div>
        <div>璇玑 xuanji</div>
      </div>
    </>
  );
}
