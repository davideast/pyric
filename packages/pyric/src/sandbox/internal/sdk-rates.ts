import type { UsageEvidence } from './usage-evidence.js';
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
interface UsageBucket { aiCompleted: number; aiInputTokens: number; aiOutputTokens: number; aiEstimatedTokens: number; aiUnknownUsage: number; aiFailures: number;  second: number; documentReads: number; documentWrites: number; documentDeletes: number; payloadBytes: number; uploadedBytes: number; downloadedBytes: number; unmeasured: number }
export interface ServiceUsageRate {
  readonly aiCompleted?: number;
  readonly aiInputTokens?: number;
  readonly aiOutputTokens?: number;
  readonly aiEstimatedTokens?: number;
  readonly aiUnknownUsage?: number;
  readonly aiFailures?: number;

  readonly uploadedBytes?: number;
  readonly downloadedBytes?: number;
  readonly documentReads: number;
  readonly documentWrites: number;
  readonly documentDeletes: number;
  readonly payloadBytes: number;
  readonly unmeasured: number;
}
const usageKeys = ['aiCompleted', 'aiInputTokens', 'aiOutputTokens', 'aiEstimatedTokens', 'aiUnknownUsage', 'aiFailures', 'documentReads', 'documentWrites', 'documentDeletes', 'payloadBytes', 'uploadedBytes', 'downloadedBytes', 'unmeasured'] as const;
function emptyUsage(second: number): UsageBucket {
  return { second, aiCompleted: 0, aiInputTokens: 0, aiOutputTokens: 0, aiEstimatedTokens: 0, aiUnknownUsage: 0, aiFailures: 0, documentReads: 0, documentWrites: 0, documentDeletes: 0, payloadBytes: 0, uploadedBytes: 0, downloadedBytes: 0, unmeasured: 0 };
}
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
export interface AiRequestObservation { readonly response?: SdkActivityRecord['response']; readonly id: string; readonly startedAt?: number; readonly startedSecond?: number; readonly at: number; readonly second: number; readonly method: string; readonly status: string; readonly detail: NonNullable<SdkActivityRecord['ai']> }
export interface SdkServiceRate {
  readonly aiInProgress?: number;
  readonly aiRequests?: readonly AiRequestObservation[];
  readonly service: EventService;
  readonly usage?: ServiceUsageRate;
  readonly lastActivityAt?: number;
  readonly usageBuckets?: readonly (ServiceUsageRate & { readonly second: number })[];
  /** Latest activity window survives idle time; bounded to 60 one-second buckets. */
  readonly history?: { readonly endSecond: number; readonly startedSecond: number; readonly methods: readonly SdkMethodRate[]; readonly usageBuckets?: readonly (ServiceUsageRate & { readonly second: number })[] };
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
  const startedSecond = Math.floor(now() / 1000);
  const lastActivity = new Map<EventService, { second: number; at: number }>();
  const active = new Map<string, Series>();
  const usage = new Map<EventService, UsageBucket[]>();
  function recordUsage(service: EventService, second: number, evidence: UsageEvidence): void {
    let ring = usage.get(service);
    if (!ring) { ring = Array.from({ length: RETAINED_SECONDS }, () => emptyUsage(-Infinity)); usage.set(service, ring); }
    const slot = ringSlot(second);
    if (ring[slot]!.second !== second) ring[slot] = emptyUsage(second);
    for (const key of usageKeys) {
      const value = evidence[key];
      if (value !== undefined && Number.isFinite(value) && value >= 0) ring[slot]![key] += value;
    }
  }
  const aiRequests: AiRequestObservation[] = [];
  const aiActive = new Map<string, { at: number; second: number }>();
  let sequence = 0;
  for (const service of ['firestore', 'rtdb', 'storage', 'ai'] as const) {
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
  function record(event: SdkObservation, response?: SdkActivityRecord['response']): void {
    if (event.sequence <= sequence) return;
    sequence = event.sequence;
    const row = series.get(`${event.service}/${event.method}`);
    if (!row) return;
    if (event.service === 'ai' && event.phase === 'start') aiActive.set(event.activityId, { at: event.at, second: Math.floor(event.monotonicAt / 1000) });
    if (event.usage) {
      recordUsage(event.service, Math.floor(event.monotonicAt / 1000), event.usage);
      lastActivity.set(event.service, { second: Math.floor(event.monotonicAt / 1000), at: event.at });
    }
    if (event.ai && event.phase !== 'remove') {
      const index = aiRequests.findIndex(request => request.id === event.activityId);
      const previous = aiRequests[index];
      const request = Object.freeze({ id: event.activityId, startedAt: previous?.startedAt ?? aiActive.get(event.activityId)?.at ?? event.at,
        startedSecond: previous?.startedSecond ?? aiActive.get(event.activityId)?.second ?? Math.floor(event.monotonicAt / 1000),
        at: event.at, second: Math.floor(event.monotonicAt / 1000), method: event.method, status: event.status, response, detail: event.ai });
      if (index < 0) aiRequests.push(request); else aiRequests[index] = request;
      if (aiRequests.length > 100) aiRequests.shift();
    }
    if (event.phase === 'transport') return;
    if (event.phase === 'end' || event.phase === 'remove') {
      aiActive.delete(event.activityId);
      const listener = active.get(event.activityId);
      if (listener) {
        --listener.activeListeners;
        active.delete(event.activityId);
      }
      return;
    }
    row.observed = true;
    const second = Math.floor(event.monotonicAt / 1000);
    if ((event.phase === 'start' && row.category !== 'listener') || (event.phase === 'delivery' && row.category === 'listener')) {
      lastActivity.set(event.service, { second, at: event.at });
    }
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
    const services = (['firestore', 'rtdb', 'storage', 'ai'] as const).map(service => {
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
      const last = lastActivity.get(service);
      const historyEnd = last ? Math.min(second, last.second + 2) : second;
      const historyMethods = methods.map(method => {
        const row = series.get(`${service}/${method.method}`)!;
        const buckets = Array.from({ length: RETAINED_SECONDS }, (_, index) => {
          const stamp = historyEnd - RETAINED_SECONDS + 1 + index;
          const bucket = row.buckets[ringSlot(stamp)]!;
          return Object.freeze({ second: stamp, calls: bucket.second === stamp ? bucket.calls : 0,
            deliveries: bucket.second === stamp ? bucket.deliveries : 0 });
        });
        return Object.freeze({ ...method, buckets: Object.freeze(buckets) });
      });
      const usageWindow = (end: number) => Object.freeze(Array.from({ length: RETAINED_SECONDS }, (_, index) => {
        const stamp = end - RETAINED_SECONDS + 1 + index;
        const bucket = usage.get(service)?.[ringSlot(stamp)];
        return Object.freeze(bucket?.second === stamp ? { ...bucket } : emptyUsage(stamp));
      }));
      const totals = emptyUsage(second);
      for (const bucket of usage.get(service) ?? []) {
        if (bucket.second <= second && bucket.second > second - WINDOW_SECONDS) {
          for (const key of usageKeys) totals[key] += bucket[key];
        }
      }
      const measurement = Object.freeze({ ...(service === 'ai' ? { aiCompleted: totals.aiCompleted / WINDOW_SECONDS, aiInputTokens: totals.aiInputTokens / WINDOW_SECONDS, aiOutputTokens: totals.aiOutputTokens / WINDOW_SECONDS, aiEstimatedTokens: totals.aiEstimatedTokens / WINDOW_SECONDS, aiUnknownUsage: totals.aiUnknownUsage / WINDOW_SECONDS, aiFailures: totals.aiFailures / WINDOW_SECONDS } : {}), documentReads: totals.documentReads / WINDOW_SECONDS,
        documentWrites: totals.documentWrites / WINDOW_SECONDS, documentDeletes: totals.documentDeletes / WINDOW_SECONDS,
        payloadBytes: totals.payloadBytes / WINDOW_SECONDS, uploadedBytes: totals.uploadedBytes / WINDOW_SECONDS, downloadedBytes: totals.downloadedBytes / WINDOW_SECONDS, unmeasured: totals.unmeasured });
      return Object.freeze({ service, ...(service === 'ai' ? { aiRequests: Object.freeze([...aiRequests]), aiInProgress: aiActive.size } : {}), usage: measurement, usageBuckets: usageWindow(second),
        ...(last ? { lastActivityAt: last.at } : {}),
        history: Object.freeze({ endSecond: historyEnd, startedSecond, methods: Object.freeze(historyMethods), usageBuckets: usageWindow(historyEnd) }), coverage: methods.length ? 'partial' as const : 'unsupported' as const,
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
  const dispose = journal.observe(event => rates.record(event, event.ai ? journal.records().find(record => record.id === event.activityId)?.response : undefined));
  return Object.freeze({ snapshot: rates.snapshot, dispose });
}

// Separate source/dist runtime bundles share one observer and one accumulation.
const RATES_KEY = Symbol.for('pyric.sdk-rates');
const globalStore = globalThis as { [RATES_KEY]?: ReturnType<typeof createSdkRateMonitor> };
export const sdkRates = globalStore[RATES_KEY] ?? (globalStore[RATES_KEY] = createSdkRateMonitor());
