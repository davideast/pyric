import { useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface VirtualListProps<T> {
  items: ReadonlyArray<T>;
  /** Estimated row height in px. `useVirtualizer` measures actual
   *  rendered heights via ResizeObserver — this is just the guess
   *  used before measurement. Pass a function for variable sizing. */
  estimateSize: number | ((index: number) => number);
  /** Render one row. The library handles positioning + key-by-index. */
  renderItem: (item: T, index: number) => ReactNode;
  /**
   * Number of off-screen rows to render on each side. TanStack
   * default is 5; bump for smoother fast scrolling.
   */
  overscan?: number;
  /** Forwarded to the scroll container. */
  className?: string;
  /** Height the scroll container fills. Default `100%` — the
   *  consumer's parent typically constrains height. */
  height?: number | string;
  /** Optional `key` resolver. Defaults to the index. Use when rows
   *  reorder so React can preserve component state across moves. */
  getItemKey?: (item: T, index: number) => string | number;
}

/**
 * Thin wrapper around `@tanstack/react-virtual`. Renders a
 * scrollable container with absolutely-positioned rows, drawing
 * only the rows currently in view (plus `overscan` neighbors).
 *
 * Headless — no shipped CSS beyond what's structurally required
 * to position rows (the inner spacer's `height` + each row's
 * `position: absolute; top: …px`). Consumers style via the
 * `className` prop and standard CSS targeting `[data-pyric-ui=
 * "virtual-list"]` on the scroll container and
 * `[data-pyric-virtual-row]` on each row.
 */
export function VirtualList<T>({
  items,
  estimateSize,
  renderItem,
  overscan = 5,
  className,
  height = '100%',
  getItemKey,
}: VirtualListProps<T>) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const estimator =
    typeof estimateSize === 'function' ? estimateSize : () => estimateSize;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: estimator,
    overscan,
  });

  return (
    <div
      ref={parentRef}
      className={className}
      data-pyric-ui="virtual-list"
      style={{
        height,
        overflowY: 'auto',
        // `contain` keeps the browser from spending paint cost on
        // off-screen rows even before the virtualizer culls them.
        contain: 'strict',
      }}
    >
      <div
        data-pyric-virtual-inner
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const item = items[vi.index];
          const key = getItemKey ? getItemKey(item, vi.index) : vi.key;
          return (
            <div
              key={key}
              data-pyric-virtual-row
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {renderItem(item, vi.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
