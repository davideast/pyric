/**
 * `useIsMobile` — match-media wrapper for the mobile breakpoint.
 * Matches Tailwind's `md` breakpoint at 768px so JS state and CSS
 * `md:` utilities flip at the same width.
 */
import { useEffect, useState } from 'react';

const QUERY = '(max-width: 767px)';

export function useIsMobile(): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return matches;
}
