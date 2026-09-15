/** Per-page investigation limits. These are not service quotas or billing limits. */
export const THRESHOLD_SERVICES = ['firestore', 'rtdb', 'storage', 'ai'] as const;
export type ThresholdService = typeof THRESHOLD_SERVICES[number];
export const THRESHOLD_OPERATIONS = {
  ai: [{ key: 'requests', label: 'Requests', default: 2 }, { key: 'inputTokens', label: 'Backend input tokens', default: 2000 }, { key: 'outputTokens', label: 'Backend output tokens', default: 500 }],
  firestore: [
    { key: 'documentReads', label: 'Document reads', default: 20 },
    { key: 'documentWrites', label: 'Document writes', default: 5 },
    { key: 'documentDeletes', label: 'Document deletes', default: 5 },
  ],
  storage: [
    { key: 'reads', label: 'Reads', default: 10 },
    { key: 'writes', label: 'Writes', default: 5 },
    { key: 'deletes', label: 'Deletes', default: 5 },
  ],
  rtdb: [
    { key: 'reads', label: 'Reads', default: 10 },
    { key: 'writes', label: 'Writes', default: 5 },
    { key: 'deliveries', label: 'Deliveries', default: 20 },
  ],
} as const;
export type ThresholdOperation = typeof THRESHOLD_OPERATIONS[ThresholdService][number]['key'];
export interface ThresholdConfig {
  ai?: Partial<Record<'requests' | 'inputTokens' | 'outputTokens', number | null>>;
  sustainedSeconds?: number;
  firestore?: Partial<Record<'documentReads' | 'documentWrites' | 'documentDeletes', number | null>>;
  storage?: Partial<Record<'reads' | 'writes' | 'deletes', number | null>>;
  rtdb?: Partial<Record<'reads' | 'writes' | 'deliveries', number | null>>;
}
export function isThresholdService(value: string | null): value is ThresholdService {
  return value === 'ai' || value === 'firestore' || value === 'rtdb' || value === 'storage';
}
export function thresholdLimit(config: ThresholdConfig, service: ThresholdService, key: ThresholdOperation): number | null {
  const values: Partial<Record<ThresholdOperation, number | null>> = config[service] ?? {};
  const value = values[key];
  return value === undefined ? THRESHOLD_OPERATIONS[service].find(operation => operation.key === key)!.default : value;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}
/** Validate both disk configuration and browser writes with one contract. */
export function readThresholdConfig(value: unknown): ThresholdConfig {
  if (value === undefined) return {};
  const config = object(value, 'runtime.thresholds');
  for (const key of Object.keys(config)) {
    if (!['sustainedSeconds', ...THRESHOLD_SERVICES].includes(key)) throw new Error(`Unknown threshold setting: ${key}.`);
  }
  const duration = config.sustainedSeconds;
  if (duration !== undefined && (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 1 || duration > 60)) {
    throw new Error('Sustained duration must be between 1 and 60 whole seconds.');
  }
  for (const service of THRESHOLD_SERVICES) {
    if (config[service] === undefined) continue;
    const limits = object(config[service], service);
    for (const [key, limit] of Object.entries(limits)) {
      if (!THRESHOLD_OPERATIONS[service].some(operation => operation.key === key)) throw new Error(`Unknown ${service} threshold: ${key}.`);
      if (limit !== null && (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0 || limit > 1_000_000)) {
        throw new Error('Limits must be greater than zero and at most 1,000,000, or null to turn a warning off.');
      }
    }
  }
  return structuredClone(config) as ThresholdConfig;
}
export function thresholdDefaults(config: ThresholdConfig, service: ThresholdService): ThresholdConfig {
  const next = { ...config };
  delete next[service];
  delete next.sustainedSeconds;
  return next;
}
