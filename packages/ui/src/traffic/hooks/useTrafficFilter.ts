import { useMemo, useState } from 'react';
import type { TrafficEvent } from '../types.js';

/**
 * `user` keeps everything that isn't a listener re-eval (user ops
 * plus their transaction/batch sub-ops); `listener` keeps only
 * listener re-evals; `all` keeps everything.
 */
export type TrafficOriginFilter = 'user' | 'all' | 'listener';

export type TrafficResultFilter = 'all' | 'allow' | 'deny';

export interface UseTrafficFilterOptions {
  events: TrafficEvent[];
  /**
   * Default `user` — the probe found listener traffic is 94–99.6%
   * of events, so it's hidden until explicitly asked for.
   */
  initialOrigin?: TrafficOriginFilter;
  /** Default `all` — the probe found ~75–80% allow in realistic
   *  sessions, so hiding either side loses diagnostic signal. */
  initialResult?: TrafficResultFilter;
  initialPathQuery?: string;
}

export interface TrafficFilterState {
  origin: TrafficOriginFilter;
  result: TrafficResultFilter;
  pathQuery: string;
}

export interface UseTrafficFilterResult {
  /** Events passing all three filters, in the input order. */
  filtered: TrafficEvent[];
  filter: TrafficFilterState;
  setOrigin: (origin: TrafficOriginFilter) => void;
  setResult: (result: TrafficResultFilter) => void;
  setPathQuery: (pathQuery: string) => void;
}

/**
 * Derives a filtered view over a traffic buffer along three
 * dimensions: origin, result, and a case-insensitive path substring.
 * Owns the filter state; pure derivation otherwise.
 */
export function useTrafficFilter({
  events,
  initialOrigin = 'user',
  initialResult = 'all',
  initialPathQuery = '',
}: UseTrafficFilterOptions): UseTrafficFilterResult {
  const [origin, setOrigin] = useState<TrafficOriginFilter>(initialOrigin);
  const [result, setResult] = useState<TrafficResultFilter>(initialResult);
  const [pathQuery, setPathQuery] = useState(initialPathQuery);

  const filtered = useMemo(() => {
    const needle = pathQuery.trim().toLowerCase();
    return events.filter((e) => {
      if (origin === 'user' && e.origin === 'listener') return false;
      if (origin === 'listener' && e.origin !== 'listener') return false;
      if (result !== 'all' && e.result !== result) return false;
      if (needle && !e.path.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [events, origin, result, pathQuery]);

  return {
    filtered,
    filter: { origin, result, pathQuery },
    setOrigin,
    setResult,
    setPathQuery,
  };
}
