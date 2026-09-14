import { sdkActivity, type SdkActivityRecord, type createSdkActivityJournal } from './sdk-activity.js';
import type { EventService } from '../types/operation.js';
import { observationService, type SdkObservation } from './sdk-observation.js';
import { sdkMethodCoverage, sdkUntrackedMethods, type SdkMethodCategory } from './sdk-coverage.js';

const RETAINED_SECONDS = 60;
const WINDOW_SECONDS = 5;
function ringSlot(second: number): number {
  return ((second % RETAINED_SECONDS) + RETAINED_SECONDS) % RETAINED_SECONDS;
}
interface Bucket { second: number; calls: number; deliveries: number }
interface Series {
  service: EventService;
  method: string;
  category: SdkMethodCategory;
  buckets: Bucket[];
  activeListeners: number;
  observed: boolean;
}
export interface SdkRateBucket {
  readonly second: number;
  readonly calls: number;
  readonly deliveries: number;
}
export interface SdkMethodRate {
  readonly method: string;
  readonly category: SdkMethodCategory;
  readonly callsPerSecond: number;
  readonly deliveriesPerSecond: number;
  readonly activeListeners: number;
  readonly observed: boolean;
  readonly buckets: readonly SdkRateBucket[];
}
export interface SdkServiceRate {
  readonly service: EventService;
  /** Unsupported services have no methods or numeric totals to imply zero usage. */
  readonly coverage: 'partial' | 'unsupported';
  readonly untrackedMethods: readonly string[];
  readonly observed: boolean;
  readonly methods: readonly SdkMethodRate[];
}
export interface SdkRateSnapshot {
  readonly monotonicAt: number;
  readonly windowSeconds: number;
  readonly services: readonly SdkServiceRate[];
}

/**
 * One accumulator per ordered journal observer stream. Sequence watermarks discard
 * replay without retaining completed activities. Only live listener IDs are held.
 * Fixed method coverage bounds series count; fixed rings bound event storage.
 */
export function createSdkRates(options: { monotonicNow?: () => number; activeListeners?: readonly SdkActivityRecord[] } = {}) {
  const now = options.monotonicNow ?? (() => performance.now());
  const series = new Map<string, Series>();
  const active = new Map<string, Series>();
  let sequence = 0;
  for (const service of ['firestore', 'rtdb', 'storage'] as const) {
    for (const entry of sdkMethodCoverage(service)) {
      series.set(`${service}/${entry.method}`, {
        service, ...entry, observed: false, activeListeners: 0,
        buckets: Array.from({ length: RETAINED_SECONDS }, () => ({ second: -Infinity, calls: 0, deliveries: 0 })),
      });
    }
  }
  // A late subscriber can seed the live gauge without inventing historical calls.
  for (const listener of options.activeListeners ?? []) {
    if (listener.kind !== 'subscription' || listener.endedAt !== undefined) continue;
    const service = observationService(listener.service);
    const row = series.get(`${service}/${listener.method}`);
    if (row && !active.has(listener.id)) {
      active.set(listener.id, row);
      ++row.activeListeners;
      row.observed = true;
    }
  }
  function record(event: SdkObservation): void {
    if (event.sequence <= sequence) return;
    sequence = event.sequence;
    const row = series.get(`${event.service}/${event.method}`);
    if (!row) return;
    if (event.phase === 'end' || event.phase === 'remove') {
      const listener = active.get(event.activityId);
      if (listener) {
        --listener.activeListeners;
        active.delete(event.activityId);
      }
      return;
    }
    row.observed = true;
    const second = Math.floor(event.monotonicAt / 1000);
    const slot = ringSlot(second);
    let bucket = row.buckets[slot]!;
    if (bucket.second !== second) {
      bucket = { second, calls: 0, deliveries: 0 };
      row.buckets[slot] = bucket;
    }
    if (event.phase === 'start') {
      ++bucket.calls;
      if (event.kind === 'subscription' && !active.has(event.activityId)) {
        ++row.activeListeners;
        active.set(event.activityId, row);
      }
    } else if (event.phase === 'delivery') {
      ++bucket.deliveries;
    }
  }
  function snapshot(): SdkRateSnapshot {
    const monotonicAt = now();
    const second = Math.floor(monotonicAt / 1000);
    const services = (['firestore', 'rtdb', 'storage'] as const).map(service => {
      const methods = [...series.values()].filter(row => row.service === service).map(row => {
        const buckets = Array.from({ length: RETAINED_SECONDS }, (_, index) => {
          const stamp = second - RETAINED_SECONDS + 1 + index;
          const slot = ringSlot(stamp);
          const bucket = row.buckets[slot]!;
          return Object.freeze({ second: stamp, calls: bucket.second === stamp ? bucket.calls : 0,
            deliveries: bucket.second === stamp ? bucket.deliveries : 0 });
        });
        const recent = buckets.slice(-WINDOW_SECONDS);
        return Object.freeze({ method: row.method, category: row.category,
          callsPerSecond: recent.reduce((sum, bucket) => sum + bucket.calls, 0) / WINDOW_SECONDS,
          deliveriesPerSecond: recent.reduce((sum, bucket) => sum + bucket.deliveries, 0) / WINDOW_SECONDS,
          activeListeners: row.activeListeners, observed: row.observed, buckets: Object.freeze(buckets) });
      });
      return Object.freeze({ service, coverage: methods.length ? 'partial' as const : 'unsupported' as const,
        untrackedMethods: sdkUntrackedMethods(service),
        observed: methods.some(method => method.observed), methods: Object.freeze(methods) });
    });
    return Object.freeze({ monotonicAt, windowSeconds: WINDOW_SECONDS, services: Object.freeze(services) });
  }
  return Object.freeze({ record, snapshot });
}

/** Install independently of any UI; disposing a view must not dispose its monitor. */
export function createSdkRateMonitor(
  journal: ReturnType<typeof createSdkActivityJournal> = sdkActivity,
  options: { monotonicNow?: () => number } = {},
) {
  const rates = createSdkRates({ ...options, activeListeners: journal.records() });
  const dispose = journal.observe(rates.record);
  return Object.freeze({ snapshot: rates.snapshot, dispose });
}

// Separate source/dist runtime bundles share one observer and one accumulation.
const RATES_KEY = Symbol.for('pyric.sdk-rates');
const globalStore = globalThis as { [RATES_KEY]?: ReturnType<typeof createSdkRateMonitor> };
export const sdkRates = globalStore[RATES_KEY] ?? (globalStore[RATES_KEY] = createSdkRateMonitor());
