import { measurementNotes } from './rate-measurement-notes.js';
import { z } from 'zod';
import type { SandboxEvent } from 'pyric/sandbox';
import type { HistoryFrame } from './rate-history.js';
import { readThresholdConfig, type ThresholdConfig } from './rate-threshold-config.js';

const number = z.number().finite();
const count = number.nonnegative();
const counts = z.object({ completed: count.optional(), requests: count.optional(), failures: count.optional(), inputTokens: count.optional(), outputTokens: count.optional(), estimatedTokens: count.optional(), unknownUsage: count.optional(), uploadedBytes: count.optional(), downloadedBytes: count.optional(), reads: count, writes: count, deletes: count, deliveries: count });
const bucket = z.object({ second: number.int(), calls: count, deliveries: count });
const method = z.object({ method: z.string().max(200), category: z.enum(['read', 'write', 'listener']), observed: z.boolean(), activeListeners: count, callsPerSecond: count, deliveriesPerSecond: count, buckets: z.array(bucket).max(1800) });
const aiDetail = z.object({ requestedModel: z.string().max(1000), routedModel: z.string().max(1000).optional(), reportedModel: z.string().max(1000).optional(), engine: z.enum(['scripted','openai','gemini','custom','unknown']), endpoint: z.string().max(1000).optional(), mappingReason: z.string().max(1000).optional(), usageSource: z.enum(['backend','estimated','scripted','unknown']), inputTokens: count.optional(), outputTokens: count.optional(), totalTokens: count.optional(), durationMs: count.optional(), firstChunkMs: count.optional() });
const aiRequest = z.object({ startedAt: number.optional(), startedSecond: number.int().optional(), id: z.string().max(200), at: number, second: number.int(), method: z.string().max(200), status: z.string().max(30), detail: aiDetail });
const service = z.object({ aiInProgress: count.optional(), aiRequests: z.array(aiRequest).max(100).optional(), service: z.enum(['firestore', 'rtdb', 'storage', 'ai']), coverage: z.enum(['partial', 'unsupported']), observed: z.boolean(), untrackedMethods: z.array(z.string().max(200)).max(100), methods: z.array(method).max(100) });
const frameSchema = z.object({ service, points: z.array(counts.extend({ second: number.int() })).min(1).max(1800), from: number.int(), to: number.int(), duration: count.positive(), clockOffset: number, totals: counts, peaks: counts });
const incidentSchema = z.object({ id: z.string().max(200), service: z.enum(['firestore', 'rtdb', 'storage', 'ai']), operation: z.enum(['documentReads', 'documentWrites', 'documentDeletes', 'reads', 'writes', 'deliveries', 'deletes', 'requests', 'inputTokens', 'outputTokens']), limit: count.positive(), sustainedSeconds: count.positive(), from: number.int(), to: number.int(), peak: count, aboveSeconds: count, aboveRanges: z.array(z.object({ from: number.int(), to: number.int() })).max(1800), recovered: z.boolean(), reviewed: z.boolean(), at: number });
const schema = z.object({ schema: z.literal('pyric.rate-capture.v1'), createdAt: z.string(), frame: frameSchema.extend({ incident: incidentSchema.optional(), warnings: z.array(z.object({ from: number.int(), to: number.int() })).max(1800).optional() }), thresholds: z.unknown() });

/** Validate imported measurements before they reach HTML or chart arithmetic. */
export function readRateCapture(text: string): { frame: HistoryFrame; thresholds: ThresholdConfig } {
  if (text.length > 32 * 1024 * 1024) throw new Error('Capture exceeds 32 MB.');
  const result = schema.safeParse(JSON.parse(text));
  if (!result.success) throw new Error('Choose a Pyric rate capture with valid measurements.');
  const { frame } = result.data;
  if (frame.to < frame.from || frame.duration !== frame.to - frame.from + 1 || frame.from < frame.points[0]!.second || frame.to > frame.points.at(-1)!.second || frame.points.some((point, index) => index > 0 && point.second !== frame.points[index - 1]!.second + 1)) throw new Error('Capture has an invalid time range.');
  const selected = frame.points.filter(point => point.second >= frame.from && point.second <= frame.to);
  for (const key of ['reads', 'writes', 'deletes', 'deliveries'] as const) {
    frame.totals[key] = selected.reduce((sum, point) => sum + point[key], 0);
    frame.peaks[key] = Math.max(...selected.map(point => point[key]));
  }
  for (const key of ['uploadedBytes', 'downloadedBytes'] as const) if (frame.service.service === 'storage') {
    frame.totals[key] = selected.reduce((sum, point) => sum + (point[key] ?? 0), 0);
    frame.peaks[key] = Math.max(0, ...selected.map(point => point[key] ?? 0));
  }
  if (frame.service.service === 'ai') for (const key of ['requests', 'completed', 'failures', 'inputTokens', 'outputTokens', 'estimatedTokens', 'unknownUsage'] as const) {
    frame.totals[key] = selected.reduce((sum, point) => sum + (point[key] ?? 0), 0);
    frame.peaks[key] = Math.max(0, ...selected.map(point => point[key] ?? 0));
  }
  const labels = { requests: 'Requests', inputTokens: 'Backend input tokens', outputTokens: 'Backend output tokens', documentReads: 'Document reads', documentWrites: 'Document writes', documentDeletes: 'Document deletes', reads: 'Reads', writes: 'Writes', deliveries: 'Deliveries', deletes: 'Deletes' };
  const incident = frame.incident ? { ...frame.incident, label: labels[frame.incident.operation], evidence: { monotonicAt: frame.to * 1000, windowSeconds: 5, services: [frame.service] } } : undefined;
  return { frame: { ...frame, incident, paused: true }, thresholds: readThresholdConfig(result.data.thresholds) };
}

export function buildRateCapture(frame: HistoryFrame, thresholds: ThresholdConfig, events: readonly SandboxEvent[], sessionFixture: unknown = null, attachmentError: string | null = null) {
  const start = frame.clockOffset + frame.from * 1000;
  const end = frame.clockOffset + (frame.to + 1) * 1000;
  return {
    schema: 'pyric.rate-capture.v1', createdAt: new Date().toISOString(),
    measurement: { scope: 'This page', bucketSeconds: 1, average: 'Selected totals divided by all selected seconds, including idle seconds.', notes: structuredClone(measurementNotes(frame.service.service)) },
    frame: structuredClone(frame), thresholds: structuredClone(thresholds),
    thresholdsScope: 'Settings at export time. Selected incident details retain the limit and duration that triggered it.',
    operations: events.filter(event => event.at >= start && event.at < end && event.service === frame.service.service),
    sessionFixtureUnavailableReason: attachmentError ?? (sessionFixture === null ? 'No session fixture is available from this host.' : null),
    operationCoverage: 'Up to 20,000 retained events from this page. Registrations before the selected period may be outside this list.',
    replay: { available: false, reason: 'No starting-state checkpoint or complete timed replay was captured for this selected interval.' },
    sessionFixture: sessionFixture === null ? null : { scope: 'Full session at export time, not the starting state of the selected period.', fixture: sessionFixture },
  };
}

/** Read the existing protected capture endpoint without changing persistence settings. */
export async function readSessionFixture(fetcher: typeof fetch): Promise<unknown | null> {
  const init = await fetcher('/__pyric/init.json');
  if (init.status === 404 || !init.headers.get('content-type')?.includes('application/json')) return null;
  if (!init.ok) throw new Error('Unable to connect to the session capture.');
  const config = await init.json();
  if (typeof config.sessionToken !== 'string') return null;
  const response = await fetcher('/__pyric/capture', { headers: { 'x-pyric-session-token': config.sessionToken } });
  if (response.status === 404 || !response.headers.get('content-type')?.includes('application/json')) return null;
  if (!response.ok) throw new Error('Unable to read the session fixture.');
  const fixture = await response.json();
  return fixture?.schema === 'pyric.verify.fixture.v1' ? fixture : null;
}
