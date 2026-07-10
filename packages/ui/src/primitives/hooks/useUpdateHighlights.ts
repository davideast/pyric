import { useEffect, useRef, useState } from 'react';

export type UpdateHighlightKind = 'added' | 'modified';

export interface UpdateHighlight {
  kind: UpdateHighlightKind;
  cycle: 0 | 1;
}

export interface UseUpdateHighlightsOptions<T> {
  scope: string;
  entries: ReadonlyMap<string, T>;
  equals?: (previous: T, next: T) => boolean;
  durationMs?: number;
  ready?: boolean;
}

const EMPTY_HIGHLIGHTS: ReadonlyMap<string, UpdateHighlight> = new Map();

/**
 * Tracks transient additions and modifications between keyed snapshots.
 * The first ready snapshot in each scope is a silent baseline.
 */
export function useUpdateHighlights<T>({
  scope,
  entries,
  equals = Object.is,
  durationMs = 1_200,
  ready = true,
}: UseUpdateHighlightsOptions<T>): ReadonlyMap<string, UpdateHighlight> {
  const baselineRef = useRef<{ scope: string; entries: ReadonlyMap<string, T> } | null>(null);
  const cyclesRef = useRef(new Map<string, 0 | 1>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [highlights, setHighlights] = useState<ReadonlyMap<string, UpdateHighlight>>(
    EMPTY_HIGHLIGHTS,
  );

  useEffect(() => {
    const baseline = baselineRef.current;
    if (!ready) {
      if (baseline && baseline.scope !== scope) {
        baselineRef.current = null;
        for (const timer of timersRef.current.values()) clearTimeout(timer);
        timersRef.current.clear();
        cyclesRef.current.clear();
        setHighlights(EMPTY_HIGHLIGHTS);
      }
      return;
    }
    if (!baseline || baseline.scope !== scope) {
      baselineRef.current = { scope, entries };
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
      cyclesRef.current.clear();
      setHighlights(EMPTY_HIGHLIGHTS);
      return;
    }

    const changed = new Map<string, UpdateHighlight>();
    for (const [key, value] of entries) {
      const hadValue = baseline.entries.has(key);
      const previous = baseline.entries.get(key);
      if (hadValue && equals(previous as T, value)) continue;
      const cycle: 0 | 1 = cyclesRef.current.get(key) === 0 ? 1 : 0;
      cyclesRef.current.set(key, cycle);
      changed.set(key, { kind: hadValue ? 'modified' : 'added', cycle });
    }
    baselineRef.current = { scope, entries };

    setHighlights((current) => {
      const next = new Map(current);
      let didChange = changed.size > 0;
      for (const key of current.keys()) {
        if (!entries.has(key)) {
          next.delete(key);
          didChange = true;
        }
      }
      for (const [key, marker] of changed) next.set(key, marker);
      if (!didChange) return current;
      return next.size === 0 ? EMPTY_HIGHLIGHTS : next;
    });

    for (const [key, marker] of changed) {
      const priorTimer = timersRef.current.get(key);
      if (priorTimer) clearTimeout(priorTimer);
      const timer = setTimeout(() => {
        timersRef.current.delete(key);
        setHighlights((current) => {
          if (current.get(key)?.cycle !== marker.cycle) return current;
          const next = new Map(current);
          next.delete(key);
          return next.size === 0 ? EMPTY_HIGHLIGHTS : next;
        });
      }, durationMs);
      timersRef.current.set(key, timer);
    }
  }, [durationMs, entries, equals, ready, scope]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    },
    [],
  );

  return highlights;
}
