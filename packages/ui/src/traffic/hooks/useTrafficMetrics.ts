import { useMemo } from 'react';
import type { TimeWindow } from './useTrafficBuckets.js';
import type { TrafficEvent } from '../types.js';

/**
 * Billable-metrics + rules-metrics aggregation (Traffic tab: "Billable
 * metrics" and "Rules"). Mirrors the Firebase Console
 * Usage tab's shape (per-series totals + a bucketed time series), built
 * on top of the same half-open `[window.start, window.end)` bucketing
 * kernel {@link bucketTraffic} already uses.
 *
 * ── Billable mapping (documented; verified against the sandbox source) ──
 *   reads    = get + list
 *   writes   = create + update + set
 *   deletes  = delete + remove
 *
 * A `list` event does NOT carry the number of documents the query
 * returned — `local-environment.ts` emits ONE `allow` event per query
 * before it computes/constrains the doc set, and the returned doc array
 * never rides back onto the event. Real Firestore bills a list as one
 * read PER RETURNED DOCUMENT; this stream can only honestly count list
 * OPERATIONS, not documents. So this series is "read ops", not "billable
 * reads" — an op-count proxy, not a byte-accurate bill. See the gap note
 * in the Traffic feature's tracking issue.
 *
 * An op only bills if it actually ran against data: a `deny`/`error`/
 * `unsupported`/`not-applicable` result means nothing was read or
 * written, so those never count toward billable totals. An `admin`
 * (rules-bypassed) op DOES run — admin reads/writes still bill in real
 * Firestore — so admin ops count toward billable totals even though they
 * never touch the rules-metrics series below.
 *
 * ── Rules metrics ──
 * Allows / denies / errors are rules-ENGINE verdicts: how many times the
 * rules engine actually ran and what it decided. An admin (bypassed) op
 * never reaches rules, so it must never inflate "allows" — that would
 * misrepresent the rules engine as having evaluated something it never
 * saw. `unsupported` / `not-applicable` results aren't rules verdicts
 * either (the simulator declined to evaluate) and are excluded too.
 *
 * ── Admin classification ──
 * The base `TrafficEvent` carries only `origin` (no `detail` field — the
 * sandbox-layer `RequestEvent.detail.admin` doesn't survive the
 * `operation`-kind adapter path, and rides untyped through the
 * `request`-kind cast). `origin === 'admin'` is the one signal declared
 * on the public type, so it's the default `isAdmin` predicate here.
 * Firestore's admin-lens ops don't currently set `origin: 'admin'`
 * (RTDB's do) — callers that can see the richer Studio provenance
 * (`authLens.mode === 'admin'`, as `verdict.ts#verdictFor` already
 * checks) should pass their own `isAdmin` predicate to close that gap.
 */

const READ_METHODS = new Set(['get', 'list']);
const WRITE_METHODS = new Set(['create', 'update', 'set']);
const DELETE_METHODS = new Set(['delete', 'remove']);

export type BillableSeriesKey = 'reads' | 'writes' | 'deletes';
export type RulesSeriesKey = 'allows' | 'denies' | 'errors';

export const BILLABLE_SERIES_DEFS: ReadonlyArray<{ key: BillableSeriesKey; label: string }> = [
  { key: 'reads', label: 'Read ops' },
  { key: 'writes', label: 'Writes' },
  { key: 'deletes', label: 'Deletes' },
];

export const RULES_SERIES_DEFS: ReadonlyArray<{ key: RulesSeriesKey; label: string }> = [
  { key: 'allows', label: 'Allows' },
  { key: 'denies', label: 'Denies' },
  { key: 'errors', label: 'Errors' },
];

/** Default admin predicate: the one signal the public `TrafficEvent`
 *  type declares. See the module doc for the known Firestore gap. */
export function isAdminEvent(event: Pick<TrafficEvent, 'origin'>): boolean {
  return event.origin === 'admin';
}

/** Classify a billable op, or `null` if it isn't one / never ran. */
export function classifyBillable(
  event: Pick<TrafficEvent, 'method' | 'result' | 'origin'>,
  isAdmin: (event: Pick<TrafficEvent, 'origin'>) => boolean = isAdminEvent,
): BillableSeriesKey | null {
  const executed = event.result === 'allow' || isAdmin(event);
  if (!executed) return null;
  if (READ_METHODS.has(event.method)) return 'reads';
  if (WRITE_METHODS.has(event.method)) return 'writes';
  if (DELETE_METHODS.has(event.method)) return 'deletes';
  return null;
}

/** Classify a rules-engine verdict, or `null` if it isn't one (bypassed,
 *  unsupported, or not-applicable). */
export function classifyRules(
  event: Pick<TrafficEvent, 'result' | 'origin'>,
  isAdmin: (event: Pick<TrafficEvent, 'origin'>) => boolean = isAdminEvent,
): RulesSeriesKey | null {
  if (isAdmin(event)) return null;
  if (event.result === 'allow') return 'allows';
  if (event.result === 'deny') return 'denies';
  if (event.result === 'error') return 'errors';
  return null;
}

export interface MetricPoint {
  /** 0-based bucket index, left (oldest) to right (newest). */
  index: number;
  /** Half-open bounds of this bucket `[start, end)` in epoch-ms. */
  start: number;
  end: number;
}

export interface MetricSeries {
  key: string;
  label: string;
  /** One count per bucket, aligned with `points`. */
  values: number[];
  /** Sum of `values` — the period total (the legend/card number). */
  total: number;
}

export interface TrafficMetricsResult {
  points: MetricPoint[];
  series: MetricSeries[];
  /** The largest single-bucket value across every series — the shared
   *  y-scale divisor a chart would use by default. */
  maxValue: number;
}

const EMPTY = (
  seriesDefs: ReadonlyArray<{ key: string; label: string }>,
): TrafficMetricsResult => ({
  points: [],
  series: seriesDefs.map((d) => ({ key: d.key, label: d.label, values: [], total: 0 })),
  maxValue: 0,
});

/** The shared bucketing kernel behind both metric hooks below. */
function bucketMetrics<K extends string>(
  events: readonly TrafficEvent[],
  window: TimeWindow,
  bucketCount: number,
  seriesDefs: ReadonlyArray<{ key: K; label: string }>,
  classify: (event: TrafficEvent) => K | null,
): TrafficMetricsResult {
  const span = window.end - window.start;
  if (bucketCount <= 0 || span <= 0) return EMPTY(seriesDefs);

  const width = span / bucketCount;
  const valuesByKey = new Map<K, number[]>(
    seriesDefs.map((d) => [d.key, new Array<number>(bucketCount).fill(0)]),
  );
  const totals = new Map<K, number>(seriesDefs.map((d) => [d.key, 0]));

  for (const event of events) {
    const at = event.at;
    if (at < window.start || at >= window.end) continue;
    const key = classify(event);
    if (key == null) continue;
    let i = Math.floor((at - window.start) / width);
    if (i >= bucketCount) i = bucketCount - 1;
    const bucketValues = valuesByKey.get(key)!;
    bucketValues[i]++;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  let maxValue = 0;
  for (const values of valuesByKey.values()) {
    for (const v of values) if (v > maxValue) maxValue = v;
  }

  const points: MetricPoint[] = new Array(bucketCount);
  for (let i = 0; i < bucketCount; i++) {
    points[i] = { index: i, start: window.start + i * width, end: window.start + (i + 1) * width };
  }

  const series: MetricSeries[] = seriesDefs.map((d) => ({
    key: d.key,
    label: d.label,
    values: valuesByKey.get(d.key)!,
    total: totals.get(d.key) ?? 0,
  }));

  return { points, series, maxValue };
}

/** Pure kernel behind {@link useBillableMetrics} — usable outside React. */
export function bucketBillableMetrics(
  events: readonly TrafficEvent[],
  window: TimeWindow,
  bucketCount = 24,
  isAdmin: (event: Pick<TrafficEvent, 'origin'>) => boolean = isAdminEvent,
): TrafficMetricsResult {
  return bucketMetrics(events, window, bucketCount, BILLABLE_SERIES_DEFS, (e) =>
    classifyBillable(e, isAdmin),
  );
}

/** Pure kernel behind {@link useRulesMetrics} — usable outside React. */
export function bucketRulesMetrics(
  events: readonly TrafficEvent[],
  window: TimeWindow,
  bucketCount = 24,
  isAdmin: (event: Pick<TrafficEvent, 'origin'>) => boolean = isAdminEvent,
): TrafficMetricsResult {
  return bucketMetrics(events, window, bucketCount, RULES_SERIES_DEFS, (e) =>
    classifyRules(e, isAdmin),
  );
}

export interface UseTrafficMetricsOptions {
  events: TrafficEvent[];
  window: TimeWindow;
  /** Number of buckets to divide the window into. The window itself
   *  should already be sized to the session (sandbox sessions run
   *  minutes, not days) — bucket count doesn't need to change, only the
   *  window a caller passes in. Default 24. */
  bucketCount?: number;
  /** Override admin classification (e.g. a Studio caller with
   *  `authLens` provenance available — see the module doc). Defaults to
   *  `origin === 'admin'`. */
  isAdmin?: (event: Pick<TrafficEvent, 'origin'>) => boolean;
}

/** Reads / writes / deletes, bucketed over `window`. See the module doc
 *  for the billable mapping + the "read ops, not billable reads" caveat. */
export function useBillableMetrics({
  events,
  window,
  bucketCount = 24,
  isAdmin,
}: UseTrafficMetricsOptions): TrafficMetricsResult {
  return useMemo(
    () => bucketBillableMetrics(events, window, bucketCount, isAdmin),
    [events, window.start, window.end, bucketCount, isAdmin],
  );
}

/** Allows / denies / errors, bucketed over `window`. Excludes
 *  rules-bypassed (admin) ops — see the module doc. */
export function useRulesMetrics({
  events,
  window,
  bucketCount = 24,
  isAdmin,
}: UseTrafficMetricsOptions): TrafficMetricsResult {
  return useMemo(
    () => bucketRulesMetrics(events, window, bucketCount, isAdmin),
    [events, window.start, window.end, bucketCount, isAdmin],
  );
}
