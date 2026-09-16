import type { SdkRateSnapshot, SdkServiceRate, SdkMethodRate } from 'pyric/sandbox/internal';

/** Bounded, page-local history, collected even while the chip is closed. */
export function createRateHistoryArchive(serviceName: string, retentionSeconds = 1800) {
  const methods = new Map<string, { source: SdkMethodRate; buckets: Map<number, SdkMethodRate['buckets'][number]> }>();
  const usage = new Map<number, NonNullable<SdkServiceRate['usageBuckets']>[number]>();
  let source: SdkServiceRate | undefined;
  let first: number | undefined;
  let end = 0;
  let clockOffset: number | undefined;
  return {
    record(snapshot: SdkRateSnapshot) {
      const next = snapshot.services.find(service => service.service === serviceName);
      if (!next) return;
      source = next;
      end = Math.floor(snapshot.monotonicAt / 1000);
      clockOffset ??= Date.now() - snapshot.monotonicAt;
      // Replayed host requests can predate this page's monotonic clock origin.
      first ??= next.history?.startedSecond ?? end;
      first = Math.max(first, end - retentionSeconds + 1);
      for (const method of [...(next.history?.methods ?? []), ...next.methods]) {
        const entry = methods.get(method.method) ?? { source: method, buckets: new Map() };
        entry.source = method;
        for (const bucket of method.buckets) if (bucket.second >= first) entry.buckets.set(bucket.second, { ...bucket });
        methods.set(method.method, entry);
      }
      for (const entry of methods.values()) for (const second of entry.buckets.keys()) if (second < first) entry.buckets.delete(second);
      for (const bucket of [...(next.history?.usageBuckets ?? []), ...(next.usageBuckets ?? [])]) if (bucket.second >= first) usage.set(bucket.second, { ...bucket });
      for (const second of usage.keys()) if (second < first) usage.delete(second);
    },
    bounds: () => ({ from: first ?? end, to: end, clockOffset }),
    source(): SdkServiceRate | undefined {
      if (!source) return;
      const retainedMethods = [...methods.values()].map(entry => ({ ...entry.source, buckets: [...entry.buckets.values()] }));
      const usageBuckets = [...usage.values()];
      return { ...source, methods: retainedMethods, usageBuckets, history: { startedSecond: first ?? end, endSecond: end, methods: retainedMethods, usageBuckets } };
    },
  };
}
