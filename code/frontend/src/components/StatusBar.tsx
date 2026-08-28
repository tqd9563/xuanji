import { Fragment, useEffect, useState, type ReactNode } from 'react';

/**
 * 全局状态栏(见 DESIGN.md §5「全局状态栏」)。
 *
 * 外壳家具而非视图内容:挂在 <main> 顶部、所有 <section class="view"> 之外,
 * 因此切换视图时它不重挂载、不参与 view-in 转场。
 *
 * 扩展方式:在下方 widgets 数组里加一项即可 —— 分隔线由渲染层按相邻关系自动插入,
 * 返回 null 的 widget 整枚消失(不留 0、不留占位)。不要把新信息塞进已有 widget。
 */

const clockFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const dateFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
});

/** 观象台时钟:原仪表盘 Clock 迁入,尺寸与配色一字未改 */
function ClockWidget() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="sb-item sb-clock" title="北京时间(UTC+8)">
      <span className="date">{dateFmt.format(now).replace(/\//g, '-')}</span>
      <span className="hms">{clockFmt.format(now)}</span>
    </span>
  );
}

export function StatusBar({
  health,
  reviewCount,
  onGoReview,
}: {
  health: { cli: string | null } | null;
  reviewCount: number;
  onGoReview: () => void;
}) {
  const daemonOk = !!health?.cli;

  // 从左到右排列;每项 null 表示此刻无话可说,整枚不渲染
  const widgets: (ReactNode | null)[] = [
    reviewCount > 0 ? (
      <button
        key="review"
        className="sb-item warn"
        onClick={onGoReview}
        title={`${reviewCount} 个会话等待验收,点击去仪表盘处置`}
      >
        <span className="dot" />
        待验收 <span className="n">{reviewCount}</span>
      </button>
    ) : null,
    // 异常态改的是文案本身而不只是圆点颜色:状态永不 color-alone(DESIGN.md §Accessibility)
    <span
      key="daemon"
      className={daemonOk ? 'sb-item' : 'sb-item bad'}
      title={
        health === null
          ? '正在连接后端…'
          : daemonOk
            ? `后端就绪 · ${health.cli}`
            : '后端可用,但 Claude CLI 不可达'
      }
    >
      <span className="dot" />
      {health === null ? 'daemon 连接中' : daemonOk ? 'daemon' : 'daemon 不可达'}
    </span>,
    <ClockWidget key="clock" />,
  ];

  const shown = widgets.filter((w): w is ReactNode => w !== null);

  return (
    <div className="statusbar">
      {shown.map((w, i) => (
        // 分隔线只出现在两枚 widget 之间,首枚之前不加
        <Fragment key={i}>
          {i > 0 && <span className="sb-sep" aria-hidden="true" />}
          {w}
        </Fragment>
      ))}
    </div>
  );
}
