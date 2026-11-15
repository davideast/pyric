/**
 * Registry and detector for Pyric's four JSON file formats, plus shared
 * capture relative paths (kept Node-free so sandbox-side methods can import
 * them without pulling `node:fs` into browser bundles).
 */

/** Relative path (from project root) where the live serve capture lives. */
export const CAPTURE_RELATIVE_PATH = '.pyric/last-session.json';

/** Relative path where the prior non-empty capture is preserved on reset or restore. */
export const PREVIOUS_CAPTURE_RELATIVE_PATH = '.pyric/previous-session.json';

/** Schema stamped onto sandbox state fixtures written by `sandbox exportFixture`. */
export const STATE_FIXTURE_SCHEMA = 'pyric.state-fixture.v1' as const;

const VERIFY_SESSION_SCHEMA = 'pyric.verify.fixture.v1' as const;
const REPRO_FILE_SCHEMA = 'pyric.repro.v1' as const;
const RATE_CAPTURE_SCHEMA = 'pyric.rate-capture.v1' as const;

/** Top-level keys recognized on a sandbox state fixture (versioned or legacy). */
export const STATE_FIXTURE_KEYS: ReadonlySet<string> = new Set([
  'firestore',
  'firestoreRules',
  'database',
  'databaseRules',
  'storage',
  'storageRules',
  'users',
]);

export type PyricFileKind = 'verify-session' | 'repro' | 'rate-capture' | 'state-fixture';

export interface PyricFileFormatInfo {
  kind: PyricFileKind;
  schema: string;
  label: string;
  producedBy: string;
  acceptedBy: string;
  sourceHint: string;
}

const PYRIC_FILE_FORMATS: Readonly<Record<PyricFileKind, PyricFileFormatInfo>> = {
  'verify-session': {
    kind: 'verify-session',
    schema: VERIFY_SESSION_SCHEMA,
    label: 'session capture',
    producedBy: `${CAPTURE_RELATIVE_PATH}, written while the host runs`,
    acceptedBy: 'pyric verify',
    sourceHint: `a session capture from ${CAPTURE_RELATIVE_PATH} (written while the host runs, or ${PREVIOUS_CAPTURE_RELATIVE_PATH} after a reset or restore)`,
  },
  repro: {
    kind: 'repro',
    schema: REPRO_FILE_SCHEMA,
    label: 'repro log',
    producedBy: 'pyric serve repro capture',
    acceptedBy: 'pyric serve repro replay',
    sourceHint: 'a repro log from pyric serve repro capture',
  },
  'rate-capture': {
    kind: 'rate-capture',
    schema: RATE_CAPTURE_SCHEMA,
    label: 'rate capture',
    producedBy: 'pyric sandbox saveCapture or the runtime rate monitor',
    acceptedBy: 'pyric sandbox openCapture',
    sourceHint: 'a rate capture saved in .pyric/captures/ (via pyric sandbox saveCapture or the runtime rate monitor)',
  },
  'state-fixture': {
    kind: 'state-fixture',
    schema: STATE_FIXTURE_SCHEMA,
    label: 'sandbox state fixture',
    producedBy: 'pyric sandbox exportFixture',
    acceptedBy: 'pyric sandbox seedFromFixture',
    sourceHint: 'a sandbox state fixture from pyric sandbox exportFixture',
  },
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLegacyStateFixture(record: Record<string, unknown>): boolean {
  if ('schema' in record || 'version' in record) return false;
  const keys = Object.keys(record);
  if (keys.length === 0) return false;
  return keys.every((key) => STATE_FIXTURE_KEYS.has(key));
}

/**
 * Identify which Pyric JSON file format `value` matches, or `null` when it does
 * not match any known Pyric format. Supports both versioned state fixtures
 * (`pyric.state-fixture.v1`) and legacy unversioned state fixtures.
 */
export function identifyPyricFile(value: unknown): PyricFileFormatInfo | null {
  if (!isPlainRecord(value)) return null;
  const schema = value.schema;
  if (schema === VERIFY_SESSION_SCHEMA) return PYRIC_FILE_FORMATS['verify-session'];
  if (schema === REPRO_FILE_SCHEMA) return PYRIC_FILE_FORMATS.repro;
  if (schema === RATE_CAPTURE_SCHEMA) return PYRIC_FILE_FORMATS['rate-capture'];
  if (schema === STATE_FIXTURE_SCHEMA) return PYRIC_FILE_FORMATS['state-fixture'];
  if (typeof schema === 'string') return null;
  if (isLegacyStateFixture(value)) return PYRIC_FILE_FORMATS['state-fixture'];
  return null;
}

/**
 * Build a single-line wrong-format error message that identifies what the given
 * file is, which command accepts it, and where the expected format comes from.
 */
export function formatWrongFileError(
  expected: PyricFileKind,
  actual: unknown,
  prefix?: string,
  consumerName?: string,
): string {
  const expectedInfo = PYRIC_FILE_FORMATS[expected];
  const consumer = consumerName ?? expectedInfo.acceptedBy;
  const detected = identifyPyricFile(actual);
  let guidance: string;
  if (detected !== null && detected.kind !== expected) {
    guidance =
      `This is a ${detected.label} (${detected.schema}, from ${detected.producedBy}); ` +
      `use ${detected.acceptedBy} to load it. ` +
      `${consumer} expects ${expectedInfo.sourceHint}.`;
  } else {
    guidance = `${consumer} expects ${expectedInfo.sourceHint}.`;
  }
  if (!prefix) return guidance;
  if (prefix.endsWith('.')) return `${prefix} ${guidance}`;
  return `${prefix}. ${guidance}`;
}

/** Count denied events inside a sandbox or capture event list. */
export function countDeniedEvents(events: readonly unknown[]): number {
  let denials = 0;
  for (const event of events) {
    if (
      typeof event === 'object' &&
      event !== null &&
      (event as { result?: unknown }).result === 'deny'
    ) {
      denials++;
    }
  }
  return denials;
}

/** Format an event/denial count phrase for preserved-capture notices. */
export function formatCaptureEventCounts(eventCount: number, denialCount: number): string {
  const eventWord = eventCount === 1 ? 'event' : 'events';
  const denialWord = denialCount === 1 ? 'denial' : 'denials';
  return `${eventCount} ${eventWord}, ${denialCount} ${denialWord}`;
}
