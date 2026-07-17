import { evictOldest } from './activity-bounded.js';

const MAX_PUBLIC_FINGERPRINT_LENGTH = 1_800;

export interface ActivityPublicIdentity {
  incidentFingerprint(key: string): string;
  readTarget(path: string, targetKey: string): string;
  listenerTarget(targetKey: string): string;
  clear(): void;
}

/** Keep query values useful for equality internally without exposing their digests publicly. */
export function createActivityPublicIdentity(maxFingerprints: number): ActivityPublicIdentity {
  const targetIds = new Map<string, number>();
  const incidentIds = new Map<string, number>();
  let nextId = 1;

  const idFor = (ids: Map<string, number>, key: string): number => {
    const existing = ids.get(key);
    if (existing !== undefined) return existing;
    if (ids.size >= maxFingerprints) evictOldest(ids);
    const id = nextId++;
    ids.set(key, id);
    return id;
  };

  return {
    incidentFingerprint: (key) => `activity:#${idFor(incidentIds, key)}`,
    readTarget: (path, targetKey) => targetKey === path
      ? compactActivityFingerprint(path)
      : compactActivityFingerprint(`${path}|query:#${idFor(targetIds, targetKey)}`),
    listenerTarget: (targetKey) => {
      try {
        const target = JSON.parse(targetKey) as {
          kind?: unknown;
          collection?: unknown;
          path?: unknown;
        };
        if (target.kind === 'query') {
          const collection = typeof target.collection === 'string'
            ? target.collection
            : typeof target.path === 'string'
              ? target.path
              : '<unknown>';
          return compactActivityFingerprint(JSON.stringify({
            collection,
            kind: 'query',
            query: `#${idFor(targetIds, targetKey)}`,
          }));
        }
        if (target.kind === 'doc' && typeof target.path === 'string') {
          return compactActivityFingerprint(JSON.stringify({
            kind: 'doc',
            path: target.path,
          }));
        }
      } catch {
        // Internal target keys are JSON, but diagnostics remain private on malformed input.
      }
      return JSON.stringify({
        kind: 'unknown',
        target: `#${idFor(targetIds, targetKey)}`,
      });
    },
    clear: () => {
      targetIds.clear();
      incidentIds.clear();
    },
  };
}

/** Keep public paths and target labels inside the activity transport limit. */
export function compactActivityFingerprint(value: string): string {
  if (value.length <= MAX_PUBLIC_FINGERPRINT_LENGTH) return value;
  const suffix = `…#${fingerprintHash(value)}`;
  return value.slice(0, MAX_PUBLIC_FINGERPRINT_LENGTH - suffix.length) + suffix;
}

/** Two independent 32-bit lanes give a stable 64-bit identity suffix. */
function fingerprintHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return (first >>> 0).toString(16).padStart(8, '0')
    + (second >>> 0).toString(16).padStart(8, '0');
}
