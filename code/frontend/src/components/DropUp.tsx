/** 自绘下拉(原生 select 弹层不可主题化,见 DESIGN.md 组件章)。
 *  默认向上弹出(为贴屏底的 composer 设计);`down` 切换为模态内变体 `.dd.down`。 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export function DropUp({
  id,
  value,
  options,
  onChange,
  className,
  title,
  labelOf,
  down,
  portalTo,
}: {
  id?: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  className?: string;
  title?: string;
  labelOf?: (v: string) => string;
  /** 模态内变体:向下弹出,触发钮补满字段宽度并现出 surface 底 + line 边框 */
  down?: boolean;
  /**
   * 把菜单渲染到这一层而不是留在 `.dd` 里。
   *
   * 设置对话框的右栏是滚动容器,留在原地的绝对定位菜单会被它裁掉;而改 `position: fixed`
   * 同样不行——`.modal` 用 transform 居中,transform 祖先会成为 fixed 的包含块,菜单会
   * 按对话框左上角而非视口算坐标、飞到框外再被 `overflow: hidden` 裁成一条。
   * 故挂到既不滚动、又在对话框边界内的那一层,按触发钮算相对坐标。
   */
  portalTo?: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  // WKWebView(Pake 壳)+ 触摸板轻触:首次 tap 常被当成 hover,onClick 要点第二次才派发。
  // 改由 onPointerDown 在物理按下时立即响应;keyboard(无 pointerdown)仍走 onClick。
  // pointerdown 后浏览器会补发一次 click,用该 ref 吞掉以免双触发。
  const pointerHandled = useRef(false);
  const swallowClickAfterPointer = () => {
    if (!pointerHandled.current) return false;
    pointerHandled.current = false;
    return true;
  };

  const host = portalTo?.current ?? null;

  /** portal 菜单定位:下方放不下就向上翻,永不越出承载层 */
  useLayoutEffect(() => {
    if (!open || !host || !btnRef.current) return;
    const hostR = host.getBoundingClientRect();
    const btnR = btnRef.current.getBoundingClientRect();
    const h = menuRef.current?.offsetHeight ?? 0;
    const below = btnR.bottom - hostR.top + 6;
    const above = btnR.top - hostR.top - 6 - h;
    setPos({
      left: btnR.left - hostR.left,
      top: below + h > hostR.height - 8 && above > 0 ? above : Math.min(below, hostR.height - h - 8),
      width: btnR.width,
    });
  }, [open, host, options.length]);

  /** 承载层里的滚动条一动就收起:菜单已脱离触发钮所在的滚动流,跟随只会更晕 */
  useEffect(() => {
    if (!open || !host) return;
    const scroller = host.querySelector('.stg-pane') ?? host;
    const onScroll = () => setOpen(false);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [open, host]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      // 菜单可能已 portal 到别处,点它自身不算外点
      if (
        e instanceof PointerEvent &&
        (rootRef.current?.contains(e.target as Node) || menuRef.current?.contains(e.target as Node))
      )
        return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const pick = (o: string) => {
    onChange(o);
    setOpen(false);
  };

  const menu = (
    <div
      ref={menuRef}
      className={cn('dd-menu', host && open && 'open', host && className?.includes('dim') && 'dim')}
      role="listbox"
      style={host && pos ? { left: pos.left, top: pos.top, width: pos.width } : undefined}
    >
      {options.map((o) => (
        <button
          key={o}
          className={cn('dd-item', o === value && 'sel')}
          role="option"
          aria-selected={o === value}
          title={labelOf?.(o) ?? o}
          onPointerDown={() => {
            pointerHandled.current = true;
            pick(o);
          }}
          onClick={() => {
            if (swallowClickAfterPointer()) return;
            pick(o);
          }}
        >
          <span className="dd-item-label">{labelOf?.(o) ?? o}</span>
          <span className="tick">✓</span>
        </button>
      ))}
    </div>
  );

  return (
    <div
      id={id}
      className={cn('dd', down && 'down', open && 'open', className)}
      ref={rootRef}
      title={title}
    >
      <button
        ref={btnRef}
        className="dd-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onPointerDown={() => {
          pointerHandled.current = true;
          setOpen((o) => !o);
        }}
        onClick={() => {
          if (swallowClickAfterPointer()) return;
          setOpen((o) => !o);
        }}
      >
        <span className="dd-val" title={labelOf?.(value) ?? value}>
          {labelOf?.(value) ?? value}
        </span>
        <span className="caret">▾</span>
      </button>
      {/* 移动端(≤430px)专用背景:桌面恒隐藏,详见 index.css「移动端」媒体查询块——
          自绘下拉在窄屏收敛为底部上滑 sheet,需要一层可点关闭的背景 */}
      <div className="dd-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
      {host ? (open ? createPortal(menu, host) : null) : menu}
    </div>
  );
}
