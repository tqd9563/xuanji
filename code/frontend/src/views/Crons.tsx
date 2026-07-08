import { api } from '@/api/client';
import { usePoll } from '@/lib/hooks';
import { Empty } from '@/components/shared';

export function Crons() {
  const { data } = usePoll(api.crons, 120_000);

  return (
    <>
      <div className="view-head">
        <h1>定时</h1>
        <span className="sub">应用内调度器在 M3 落地;当前只读展示系统 crontab</span>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head"><h2>璇玑定时任务</h2></div>
        <Empty>
          <p>还没有应用内定时任务。</p>
          <p style={{ color: 'var(--faint)' }}>M3 上线:croner 调度 + run history + 预算熔断 + 飞书通知。</p>
        </Empty>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>系统 crontab</h2>
          <span className="sub" title={data?.caliber}>只读列出,不接管</span>
        </div>
        {data?.system.length === 0 && <Empty><p>crontab 为空。</p></Empty>}
        <div style={{ padding: '10px 18px 16px' }}>
          {data?.system.map((line, i) => (
            <div key={i} className="mono sys-note" style={{ padding: '7px 0', fontSize: '0.75rem', borderBottom: '1px solid var(--line-soft)' }}>
              {line}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
