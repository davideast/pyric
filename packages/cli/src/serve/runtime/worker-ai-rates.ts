import { aiCompletionUsage, createSdkRates, type AiRequestObservation, type SdkRateSnapshot, type SdkObservation, type UsageEvidence } from 'pyric/sandbox/internal';

function terminalUsage(request: AiRequestObservation): UsageEvidence | undefined {
  if (request.status === 'completed') return aiCompletionUsage(request.detail, request.method);
  if (request.status === 'failed') return { aiFailures: 1, aiUnknownUsage: request.method === 'countTokens' ? 0 : 1 };
  return undefined;
}

function sdkStatus(request: AiRequestObservation, phase: 'start' | 'end'): SdkObservation['status'] {
  if (phase === 'start') return 'pending';
  if (request.status === 'completed') return 'completed';
  if (request.status === 'failed') return 'failed';
  return 'closed';
}

/** Rebuild from deduplicated execution snapshots, so replay cannot count twice. */
export function workerAiRates(requests: readonly AiRequestObservation[]) {
  const offset = Date.now() - performance.now();
  const observations: Array<{ at: number; phase: 'start' | 'end'; request: AiRequestObservation }> = [];
  for (const request of requests) {
    observations.push({ at: request.startedAt ?? request.at, phase: 'start', request });
    if (request.status !== 'pending') observations.push({ at: request.at, phase: 'end', request });
  }
  observations.sort((a, b) => a.at - b.at);
  const startedSecond = Math.floor(((observations[0]?.at ?? Date.now()) - offset) / 1000);
  const rates = createSdkRates();
  const calls = new Map<string, Map<number, { second: number; calls: number; deliveries: number }>>();
  const historyUsage = new Map<number, { second: number; documentReads: number; documentWrites: number; documentDeletes: number; payloadBytes: number; unmeasured: number; [key: string]: number }>();
  let sequence = 0;
  for (const { at, phase, request } of observations) {
    const detail = request.detail;
    const ended = phase === 'end';
    const usage = ended ? terminalUsage(request) : undefined;
    const second = Math.floor((at - offset) / 1000);
    if (phase === 'start') {
      const buckets = calls.get(request.method) ?? new Map();
      const bucket = buckets.get(second) ?? { second, calls: 0, deliveries: 0 };
      bucket.calls++;
      buckets.set(second, bucket);
      calls.set(request.method, buckets);
    }
    if (usage) {
      const bucket = historyUsage.get(second) ?? { second, documentReads: 0, documentWrites: 0, documentDeletes: 0, payloadBytes: 0, unmeasured: 0 };
      for (const [key, value] of Object.entries(usage)) if (value !== undefined) bucket[key] = (bucket[key] ?? 0) + value;
      historyUsage.set(second, bucket);
    }
    const status = sdkStatus(request, phase);
    rates.record({ sequence: ++sequence, id: `${request.id}/${phase}`, activityId: request.id,
      appId: 'host', sourceId: request.id, service: 'ai', method: request.method,
      kind: 'operation', phase, status, at, monotonicAt: at - offset,
      deliveryNumber: 0, ai: detail, usage }, request.response);
  }
  return (snapshot: SdkRateSnapshot): SdkRateSnapshot => {
    const ai = rates.snapshot().services.find(service => service.service === 'ai');
    if (!ai) return snapshot;
    const history = { startedSecond, endSecond: Math.floor(((observations.at(-1)?.at ?? Date.now()) - offset) / 1000),
      methods: ai.methods.map(method => ({ ...method, buckets: [...(calls.get(method.method)?.values() ?? [])] })),
      usageBuckets: [...historyUsage.values()],
    };
    const recorded = { ...ai, history, aiRequests: requests.map(request => ({ ...request,
      second: Math.floor((request.at - offset) / 1000),
      startedSecond: Math.floor(((request.startedAt ?? request.at) - offset) / 1000) })) };
    return { ...snapshot, services: snapshot.services.map(service => service.service === 'ai' ? recorded : service) };
  };
}
