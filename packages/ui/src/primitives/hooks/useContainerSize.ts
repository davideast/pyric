import { useEffect, useRef, useState, type RefObject } from 'react';

export type ContainerSize = 'narrow' | 'medium' | 'wide';

export interface UseContainerSizeOptions {
  /** Width (px) below which the bucket is `'narrow'`. Default 480. */
  narrowBreakpoint?: number;
  /** Width (px) below which the bucket is `'medium'` (and above
   *  which it is `'wide'`). Default 768. */
  mediumBreakpoint?: number;
}

/**
 * Container-query helper. Returns the current size bucket
 * (`'narrow' | 'medium' | 'wide'`) of the element pointed at by
 * the returned ref. Re-fires on resize via `ResizeObserver`.
 *
 *   const { ref, size } = useContainerSize();
 *   return <div ref={ref} data-size={size}>…</div>;
 *
 * Headless: the consumer styles via `[data-size='narrow']`
 * selectors. The library's feature components use this hook to
 * stamp their roots with `data-size`, which is the policy the
 * survey's modern-CSS subsection landed on (no viewport media
 * queries, no library-side breakpoints — push the threshold
 * decision to the consumer via data attributes).
 */
export function useContainerSize<T extends HTMLElement = HTMLDivElement>(
  options: UseContainerSizeOptions = {},
): { ref: RefObject<T | null>; size: ContainerSize } {
  const ref = useRef<T | null>(null);
  const narrow = options.narrowBreakpoint ?? 480;
  const medium = options.mediumBreakpoint ?? 768;
  const [size, setSize] = useState<ContainerSize>('wide');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      if (w < narrow) setSize('narrow');
      else if (w < medium) setSize('medium');
      else setSize('wide');
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [narrow, medium]);

  return { ref, size };
}
