/**
 * Pure domain logic for the Pyric Studio Functions inspector:
 * trigger family classification, endpoint/pattern formatting, unsupported
 * diagnostic parsing, Fire payload validation, and trigger filtering/grouping.
 */

import type {
  DiscoveredTrigger,
  FunctionFamily,
  UnsupportedTrigger,
} from './types.js';

export {
  extractLiveExecutions,
  formatDurationMs,
  formatJsonPreview,
  mergeExecutions,
} from './executions-model.js';

export interface FamilyMetadata {
  readonly id: FunctionFamily;
  readonly label: string;
  readonly shortLabel: string;
}

export const FUNCTION_FAMILIES: readonly FamilyMetadata[] = [
  { id: 'http', label: 'HTTP', shortLabel: 'HTTP' },
  { id: 'callable', label: 'Callable', shortLabel: 'Callable' },
  { id: 'firestore', label: 'Firestore', shortLabel: 'Firestore' },
  { id: 'rtdb', label: 'RTDB', shortLabel: 'RTDB' },
  { id: 'storage', label: 'Storage', shortLabel: 'Storage' },
  { id: 'identity', label: 'Identity', shortLabel: 'Identity' },
  { id: 'pubsub', label: 'Pub/Sub', shortLabel: 'Pub/Sub' },
  { id: 'scheduler', label: 'Scheduler', shortLabel: 'Scheduler' },
  { id: 'tasks', label: 'Tasks', shortLabel: 'Tasks' },
  { id: 'other', label: 'Other', shortLabel: 'Other' },
];

const FAMILY_META_BY_ID: Readonly<Record<FunctionFamily, FamilyMetadata>> = Object.fromEntries(
  FUNCTION_FAMILIES.map((item) => [item.id, item]),
) as Record<FunctionFamily, FamilyMetadata>;

const RTDB_CREATED_EVENT_TYPE = 'google.firebase.database.ref.v1.created';
export const DEFAULT_FUNCTION_REGION = 'us-central1';
export const DEFAULT_PROJECT_ID = 'demo-project';

export function familyMeta(family: FunctionFamily): FamilyMetadata {
  return FAMILY_META_BY_ID[family];
}

/** Classify any Cloud Functions trigger eventType into one inspector family. */
export function classifyTriggerFamily(eventType: string): FunctionFamily {
  const base = stripDiagnosticSuffix(eventType).toLowerCase();
  if (base === 'https' || base === 'http') return 'http';
  if (base === 'callable') return 'callable';
  if (base.startsWith('google.cloud.firestore.document.')) return 'firestore';
  if (base.startsWith('google.firebase.database.ref.')) return 'rtdb';
  if (base.startsWith('google.cloud.storage.object.')) return 'storage';
  if (base.startsWith('providers/cloud.auth/eventtypes/') || base === 'blocking') {
    return 'identity';
  }
  if (base.startsWith('google.cloud.pubsub.topic.')) return 'pubsub';
  if (base === 'schedule' || base.startsWith('google.cloud.scheduler.')) return 'scheduler';
  if (base === 'task-queue' || base.startsWith('google.cloud.tasks.')) return 'tasks';
  return 'other';
}

function stripDiagnosticSuffix(eventType: string): string {
  const idx = eventType.indexOf(' (');
  return idx === -1 ? eventType.trim() : eventType.slice(0, idx).trim();
}

/** Concise human-readable event label for badges and subtitles. */
export function shortEventLabel(eventType: string): string {
  const base = stripDiagnosticSuffix(eventType);
  if (base === 'https') return 'onRequest';
  if (base === 'callable') return 'onCall';
  if (base === 'schedule') return 'onSchedule';
  if (base === 'task-queue') return 'onTaskDispatched';
  if (base.startsWith('google.cloud.firestore.document.v1.')) {
    return `document.${base.slice('google.cloud.firestore.document.v1.'.length)}`;
  }
  if (base.startsWith('google.firebase.database.ref.v1.')) {
    return `ref.${base.slice('google.firebase.database.ref.v1.'.length)}`;
  }
  if (base.startsWith('google.cloud.storage.object.v1.')) {
    return `object.${base.slice('google.cloud.storage.object.v1.'.length)}`;
  }
  if (base.startsWith('providers/cloud.auth/eventTypes/')) {
    return base.slice('providers/cloud.auth/eventTypes/'.length);
  }
  if (base.startsWith('google.cloud.pubsub.topic.v1.')) {
    return base.slice('google.cloud.pubsub.topic.v1.'.length);
  }
  return base || 'unknown';
}

/** Deduplicated regions advertised by a trigger descriptor. */
export function triggerRegions(trigger: DiscoveredTrigger): string[] {
  const out: string[] = [];
  if (Array.isArray(trigger.regions)) {
    for (const region of trigger.regions) {
      if (typeof region === 'string' && region.length > 0 && !out.includes(region)) {
        out.push(region);
      }
    }
  }
  if (
    out.length === 0 &&
    typeof trigger.location === 'string' &&
    trigger.location.length > 0
  ) {
    out.push(trigger.location);
  }
  const family = classifyTriggerFamily(trigger.eventType);
  if (
    out.length === 0 &&
    (family === 'http' || family === 'callable' || family === 'scheduler' || family === 'tasks')
  ) {
    out.push(DEFAULT_FUNCTION_REGION);
  }
  return out;
}

/** Construct local emulator-style endpoint URLs for HTTP and Callable triggers. */
export function triggerEndpointUrls(
  trigger: DiscoveredTrigger,
  origin: string,
  projectId?: string | null,
): string[] {
  const family = classifyTriggerFamily(trigger.eventType);
  if (family !== 'http' && family !== 'callable') return [];
  const base = origin.replace(/\/$/, '');
  const resolvedProject =
    typeof projectId === 'string' && projectId.trim().length > 0
      ? projectId.trim()
      : DEFAULT_PROJECT_ID;
  return triggerRegions(trigger).map(
    (region) => `${base}/${resolvedProject}/${region}/${trigger.exportName}`,
  );
}

/** Primary event pattern or target summary for non-HTTP triggers. */
export function triggerEventPattern(trigger: DiscoveredTrigger): string | null {
  const family = classifyTriggerFamily(trigger.eventType);
  switch (family) {
    case 'rtdb':
      return trigger.reference ? `/${trigger.reference.replace(/^\/+/, '')}` : null;
    case 'firestore':
      return trigger.document ?? null;
    case 'storage':
      return trigger.bucket ? `gs://${trigger.bucket}` : 'default bucket';
    case 'pubsub':
      return trigger.topicResource ?? trigger.topic ?? null;
    case 'scheduler':
      return trigger.schedule ?? null;
    case 'tasks':
      return `queue/${trigger.exportName}`;
    case 'identity':
      return shortEventLabel(trigger.eventType);
    default:
      return null;
  }
}

export interface TriggerSecondaryBadge {
  label: string;
  value: string;
}

/** Extra metadata badges (database, instance, timeZone, platform, etc.). */
export function triggerMetaBadges(trigger: DiscoveredTrigger): TriggerSecondaryBadge[] {
  const badges: TriggerSecondaryBadge[] = [];
  if (trigger.platform === 'gcfv2') {
    badges.push({ label: 'gen', value: 'v2' });
  } else if (trigger.platform === 'gcfv1') {
    badges.push({ label: 'gen', value: 'v1' });
  }
  if (trigger.instance && trigger.instance !== '*') {
    badges.push({ label: 'instance', value: trigger.instance });
  }
  if (trigger.database && trigger.database !== '(default)') {
    badges.push({ label: 'db', value: trigger.database });
  }
  if (trigger.namespace && trigger.namespace !== '(default)') {
    badges.push({ label: 'ns', value: trigger.namespace });
  }
  if (trigger.timeZone) {
    badges.push({ label: 'tz', value: trigger.timeZone });
  }
  return badges;
}

export interface ParsedUnsupportedTrigger {
  exportName: string;
  rawEventType: string;
  eventType: string;
  family: FunctionFamily;
  reason: string;
}

/** Split `eventType (reason)` diagnostics emitted by CLI discovery modules. */
export function parseUnsupportedDiagnostic(
  item: UnsupportedTrigger,
): ParsedUnsupportedTrigger {
  const raw = item.eventType.trim();
  const openIdx = raw.indexOf(' (');
  const closeIdx = raw.endsWith(')') ? raw.length - 1 : -1;
  if (openIdx !== -1 && closeIdx > openIdx + 2) {
    const baseEventType = raw.slice(0, openIdx).trim();
    const reason = raw.slice(openIdx + 2, closeIdx).trim();
    return {
      exportName: item.exportName,
      rawEventType: raw,
      eventType: baseEventType,
      family: classifyTriggerFamily(baseEventType),
      reason: reason || 'Unsupported in local emulation',
    };
  }
  return {
    exportName: item.exportName,
    rawEventType: raw,
    eventType: raw || 'unknown',
    family: classifyTriggerFamily(raw),
    reason: 'Trigger type is not supported in the local runtime yet.',
  };
}

type FireMode =
  | 'rtdb-fire'
  | 'http'
  | 'callable'
  | 'scheduler'
  | 'pubsub'
  | 'tasks'
  | 'automatic';

export interface FireCapability {
  readonly fireable: boolean;
  readonly mode: FireMode;
  readonly actionLabel: string;
  readonly description: string;
}

/** Describe how a trigger can be invoked from the Studio inspector. */
export function fireCapability(trigger: DiscoveredTrigger): FireCapability {
  const family = classifyTriggerFamily(trigger.eventType);
  if (family === 'http') {
    return {
      fireable: true,
      mode: 'http',
      actionLabel: 'Invoke HTTP',
      description: 'Send a local HTTP request to this onRequest endpoint.',
    };
  }
  if (family === 'callable') {
    return {
      fireable: true,
      mode: 'callable',
      actionLabel: 'Call',
      description: 'Send a local callable JSON payload ({ data }) to this endpoint.',
    };
  }
  if (family === 'rtdb' && stripDiagnosticSuffix(trigger.eventType) === RTDB_CREATED_EVENT_TYPE) {
    return {
      fireable: true,
      mode: 'rtdb-fire',
      actionLabel: 'Fire',
      description: 'Run on a synthetic RTDB create event via functions.fire without writing to the database.',
    };
  }
  if (family === 'scheduler') {
    return {
      fireable: true,
      mode: 'scheduler',
      actionLabel: 'Fire',
      description: 'Manually trigger this scheduled function with optional JSON schedule options.',
    };
  }
  if (family === 'pubsub') {
    return {
      fireable: true,
      mode: 'pubsub',
      actionLabel: 'Fire',
      description: 'Publish a synthetic Pub/Sub message payload to this trigger topic.',
    };
  }
  if (family === 'tasks') {
    return {
      fireable: true,
      mode: 'tasks',
      actionLabel: 'Fire',
      description: 'Enqueue a synthetic Cloud Task payload to this task queue function.',
    };
  }
  if (family === 'firestore') {
    return {
      fireable: false,
      mode: 'automatic',
      actionLabel: 'Auto',
      description: 'Runs automatically on matching Firestore writes in the sandbox.',
    };
  }
  if (family === 'rtdb') {
    return {
      fireable: false,
      mode: 'automatic',
      actionLabel: 'Auto',
      description: 'Runs automatically on matching Realtime Database writes in the sandbox.',
    };
  }
  if (family === 'storage') {
    return {
      fireable: false,
      mode: 'automatic',
      actionLabel: 'Auto',
      description: 'Runs automatically on matching Storage object mutations in the sandbox.',
    };
  }
  if (family === 'identity') {
    return {
      fireable: false,
      mode: 'automatic',
      actionLabel: 'Auto',
      description: 'Runs automatically during Auth blocking lifecycle flows in the sandbox.',
    };
  }
  return {
    fireable: false,
    mode: 'automatic',
    actionLabel: 'Auto',
    description: 'Triggered automatically by the runtime.',
  };
}

/** Build a concrete RTDB path sample by filling `{param}` wildcards cleanly. */
export function sampleRtdbPathFromPattern(reference?: string): string {
  if (!reference) return 'sample/item';
  const cleaned = reference.replace(/^\/+/, '');
  if (!cleaned) return 'sample/item';
  return cleaned.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const cleanName = name.replace(/[^a-zA-Z0-9_-]/g, '') || 'id';
    return `sample-${cleanName}`;
  });
}

export type JsonPayloadParseResult =
  | { ok: true; value: unknown; isEmpty: boolean }
  | { ok: false; error: string };

/** Validate optional JSON payload input strictly before dispatching Fire. */
export function parseOptionalJsonPayload(
  raw: string,
  emptyDefault: unknown = undefined,
): JsonPayloadParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: emptyDefault, isEmpty: true };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown, isEmpty: false };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid JSON payload: ${detail}` };
  }
}

/** Validate optional flat string-map JSON attributes (for Pub/Sub). */
export function parseOptionalStringMap(
  raw: string,
): { ok: true; value: Record<string, string> | undefined } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid JSON attributes: ${detail}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Attributes must be a JSON object of string key/value pairs.' };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      return { ok: false, error: `Attribute "${k}" must have a string value.` };
    }
    out[k] = v;
  }
  return { ok: true, value: out };
}

/** Validate optional RTDB fire timeoutMs (1..60000 integer). */
export function parseOptionalTimeoutMs(
  raw: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0 || n > 60_000) {
    return { ok: false, error: 'Timeout must be a whole number between 1 and 60000 ms.' };
  }
  return { ok: true, value: n };
}

/** Filter triggers by selected family and case-insensitive search text. */
export function filterTriggers(
  triggers: readonly DiscoveredTrigger[],
  options: { family: FunctionFamily | 'all'; query: string },
): DiscoveredTrigger[] {
  const q = options.query.trim().toLowerCase();
  return triggers.filter((trigger) => {
    const family = classifyTriggerFamily(trigger.eventType);
    if (options.family !== 'all' && family !== options.family) return false;
    if (!q) return true;
    const haystack = [
      trigger.exportName,
      trigger.eventType,
      shortEventLabel(trigger.eventType),
      familyMeta(family).label,
      trigger.reference ?? '',
      trigger.document ?? '',
      trigger.bucket ?? '',
      trigger.topic ?? '',
      trigger.topicResource ?? '',
      trigger.schedule ?? '',
      trigger.timeZone ?? '',
      ...(trigger.regions ?? []),
      trigger.location ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

export interface TriggerFamilyGroup {
  family: FunctionFamily;
  label: string;
  triggers: DiscoveredTrigger[];
}

/** Group triggers in canonical family order, omitting empty groups. */
export function groupTriggersByFamily(
  triggers: readonly DiscoveredTrigger[],
): TriggerFamilyGroup[] {
  const buckets = new Map<FunctionFamily, DiscoveredTrigger[]>();
  for (const trigger of triggers) {
    const family = classifyTriggerFamily(trigger.eventType);
    const list = buckets.get(family);
    if (list) list.push(trigger);
    else buckets.set(family, [trigger]);
  }
  const groups: TriggerFamilyGroup[] = [];
  for (const meta of FUNCTION_FAMILIES) {
    const list = buckets.get(meta.id);
    if (list && list.length > 0) {
      groups.push({ family: meta.id, label: meta.label, triggers: list });
    }
  }
  return groups;
}

/** Count triggers per family (for filter pill counters). */
export function countTriggersByFamily(
  triggers: readonly DiscoveredTrigger[],
): Partial<Record<FunctionFamily, number>> {
  const counts: Partial<Record<FunctionFamily, number>> = {};
  for (const trigger of triggers) {
    const family = classifyTriggerFamily(trigger.eventType);
    counts[family] = (counts[family] ?? 0) + 1;
  }
  return counts;
}
