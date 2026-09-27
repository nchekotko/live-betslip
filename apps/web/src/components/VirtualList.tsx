import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export interface VisibleRange {
  start: number;
  end: number; // exclusive
}

/** Pure windowing math (fixed row height). */
export function computeVisibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan: number,
): VisibleRange {
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(viewportHeight, rowHeight) / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end };
}

interface Props {
  count: number;
  rowHeight: number;
  /** Viewport height in px (the list scrolls inside it). */
  height: number | string;
  overscan?: number;
  /** Below this count everything is rendered (no windowing overhead for small lists). */
  threshold?: number;
  getKey: (index: number) => string;
  renderRow: (index: number) => ReactNode;
  className?: string;
  role?: string;
  ariaLabel?: string;
  /** Fallback viewport height for environments without layout (tests/SSR). */
  fallbackViewport?: number;
}

/**
 * Minimal fixed-height virtual list. Rows are absolutely positioned inside a
 * spacer of `count * rowHeight`. Focus-based keyboard navigation still works:
 * overscan keeps the neighbour rows mounted, and focusing one scrolls it in.
 */
export function VirtualList({
  count,
  rowHeight,
  height,
  overscan = 4,
  threshold = 40,
  getKey,
  renderRow,
  className,
  role,
  ariaLabel,
  fallbackViewport = 600,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(fallbackViewport);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || fallbackViewport);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallbackViewport]);

  const virtual = count > threshold;
  const range = virtual ? computeVisibleRange(scrollTop, viewport, rowHeight, count, overscan) : { start: 0, end: count };

  const rows: ReactNode[] = [];
  for (let i = range.start; i < range.end; i++) {
    const style: CSSProperties = virtual
      ? { position: 'absolute', top: i * rowHeight, left: 0, right: 0, height: rowHeight }
      : { height: rowHeight };
    rows.push(<div key={getKey(i)} style={style} role={role === 'list' ? 'listitem' : undefined}>{renderRow(i)}</div>);
  }

  return (
    <div
      ref={ref}
      className={className}
      style={{ height, overflowY: 'auto', position: 'relative' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      role={role}
      aria-label={ariaLabel}
      data-virtualized={virtual ? 'true' : 'false'}
    >
      <div style={{ height: virtual ? count * rowHeight : undefined, position: 'relative' }}>{rows}</div>
    </div>
  );
}
