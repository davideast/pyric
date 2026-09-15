import type { SdkRateSnapshot, SdkServiceRate } from 'pyric/sandbox/internal';
import { THRESHOLD_OPERATIONS, THRESHOLD_SERVICES, thresholdLimit, type ThresholdConfig, type ThresholdOperation, type ThresholdService } from './rate-threshold-config.js';

export interface RateIncident {
  readonly id: string;
  readonly service: ThresholdService;
  readonly operation: ThresholdOperation;
  readonly label: string;
  readonly limit: number;
  readonly sustainedSeconds: number;
  readonly from: number;
  to: number;
  peak: number;
  aboveSeconds: number;
  aboveRanges: { from: number; to: number }[];
  recovered: boolean;
  reviewed: boolean;
  readonly at: number;
  evidence: SdkRateSnapshot;
}
const RECOVERY_SECONDS = 5;
interface Streak { from: number; peak: number; quietSeconds: number; incident?: RateIncident }
function count(service: SdkServiceRate, key: ThresholdOperation, second: number): number {
  if (key === 'requests') return service.methods.reduce((sum, method) => sum + (method.buckets.find(bucket => bucket.second === second)?.calls ?? 0), 0);
  if (key === 'inputTokens' || key === 'outputTokens') return service.usageBuckets?.find(bucket => bucket.second === second)?.[key === 'inputTokens' ? 'aiInputTokens' : 'aiOutputTokens'] ?? 0;
  if (key === 'documentReads' || key === 'documentWrites' || key === 'documentDeletes') {
    return service.usageBuckets?.find(bucket => bucket.second === second)?.[key] ?? 0;
  }
  const category = { reads: 'read', writes: 'write', deliveries: 'listener', deletes: 'write' }[key];
  return service.methods.filter(method => method.category === category && (service.service !== 'storage' || (key === 'deletes' ? method.method === 'deleteObject' : method.method !== 'deleteObject'))).reduce((sum, method) => {
    const bucket = method.buckets.find(bucket => bucket.second === second);
    return sum + (key === 'deliveries' ? bucket?.deliveries ?? 0 : bucket?.calls ?? 0);
  }, 0);
}
function evidence(snapshot: SdkRateSnapshot, source: SdkServiceRate, second: number): SdkRateSnapshot {
  const service = { ...source, history: { endSecond: second, startedSecond: Math.max(source.history?.startedSecond ?? 0, second - 59), methods: source.methods, usageBuckets: source.usageBuckets } };
  return structuredClone({ ...snapshot, services: [service] });
}
/** Closed one-second buckets only. Idle ticks recover incidents but never erase evidence. */
export function createRateThresholdMonitor() {
  let processed: number | undefined;
  let signature = '';
  const streaks = new Map<string, Streak>();
  const incidents: RateIncident[] = [];
  return {
    incidents: () => [...incidents].reverse(),
    pending: () => incidents.some(incident => !incident.reviewed),
    review(id: string) { const incident = incidents.find(entry => entry.id === id); if (incident) incident.reviewed = true; return incident; },
    sample(snapshot: SdkRateSnapshot, config: ThresholdConfig, wallNow = Date.now()) {
      const nextSignature = JSON.stringify(config);
      if (nextSignature !== signature) {
        for (const streak of streaks.values()) if (streak.incident) streak.incident.recovered = true;
        streaks.clear(); signature = nextSignature;
        // A changed limit applies prospectively, never to past activity.
        if (processed !== undefined) processed = Math.floor(snapshot.monotonicAt / 1000) - 1;
      }
      const end = Math.floor(snapshot.monotonicAt / 1000) - 1;
      const start = Math.max(processed === undefined ? end : processed + 1, end - 58);
      if (processed !== undefined && start > processed + 1) {
        for (const streak of streaks.values()) if (streak.incident) streak.incident.recovered = true;
        streaks.clear();
      }
      const duration = config.sustainedSeconds ?? 5;
      for (let second = start; second <= end; second++) {
        for (const serviceName of THRESHOLD_SERVICES) {
          const service = snapshot.services.find(entry => entry.service === serviceName);
          if (!service || service.coverage === 'unsupported') continue;
          for (const operation of THRESHOLD_OPERATIONS[serviceName]) {
            const key = `${serviceName}/${operation.key}`;
            const limit = thresholdLimit(config, serviceName, operation.key);
            const value = count(service, operation.key, second);
            const previous = streaks.get(key);
            if (limit === null || value <= limit) {
              if (previous?.incident && limit !== null) {
                previous.quietSeconds++;
                if (previous.quietSeconds < RECOVERY_SECONDS) continue;
                previous.incident.recovered = true;
              }
              streaks.delete(key);
              continue;
            }
            const streak = previous ?? { from: second, peak: value, quietSeconds: 0 };
            streak.quietSeconds = 0;
            streak.peak = Math.max(streak.peak, value);
            streaks.set(key, streak);
            if (second - streak.from + 1 < duration) continue;
            if (!streak.incident) {
              streak.incident = { id: `${key}/${streak.from}`, service: serviceName, operation: operation.key, label: operation.label, limit, sustainedSeconds: duration, from: streak.from, to: second, peak: streak.peak, aboveSeconds: second - streak.from + 1, aboveRanges: [{ from: streak.from, to: second }], at: wallNow - snapshot.monotonicAt + streak.from * 1000, recovered: false, reviewed: false, evidence: evidence(snapshot, service, second) };
              incidents.push(streak.incident);
              if (incidents.length > 32) incidents.shift();
            } else {
              const lastRange = streak.incident.aboveRanges.at(-1)!;
              if (lastRange.to === second - 1) lastRange.to = second;
              else streak.incident.aboveRanges.push({ from: second, to: second });
              streak.incident.aboveSeconds++;
              streak.incident.to = second;
              streak.incident.peak = streak.peak;
              streak.incident.evidence = evidence(snapshot, service, second);
            }
          }
        }
      }
      processed = end;
    },
  };
}
