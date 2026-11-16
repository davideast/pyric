import type { JsonValue } from '@pyric/rules/internal/rtdb';

/** A Realtime Database ruleset, in the `{ rules: ... }` envelope the SDK takes. */
export interface DatabaseRuleset {
  rules: Record<string, unknown>;
}

/**
 * Strip the inline `rules` key from an exported Realtime Database envelope so
 * rules live once under `FullSandboxState['rules']['database']`.
 */
export function stripDatabaseRules(exported: JsonValue): JsonValue {
  const isObject = exported !== null && typeof exported === 'object' && !Array.isArray(exported);
  if (!isObject) return exported;
  const envelope: Record<string, JsonValue> = { ...(exported as Record<string, JsonValue>) };
  delete envelope.rules;
  return envelope as unknown as JsonValue;
}

/** Whether a Realtime Database tree value carries no entries. */
export function isEmptyRtdbTree(data: JsonValue | undefined): boolean {
  if (data === null || data === undefined) return true;
  if (typeof data === 'object' && !Array.isArray(data)) {
    return Object.keys(data).length === 0;
  }
  return false;
}

/** Build a persistence envelope carrying both the target RTDB tree and its ruleset for atomic restore. */
export function databaseEnvelopeWithRules(
  database: JsonValue,
  rules: DatabaseRuleset | null,
): JsonValue {
  const clonedDb = structuredClone(database);
  const clonedRules = structuredClone(rules) as JsonValue;
  if (
    clonedDb !== null &&
    typeof clonedDb === 'object' &&
    !Array.isArray(clonedDb) &&
    (clonedDb as Record<string, JsonValue>)['.pyricRtdbPersistence'] === 1 &&
    'data' in clonedDb &&
    typeof (clonedDb as Record<string, JsonValue>).priorities === 'object' &&
    (clonedDb as Record<string, JsonValue>).priorities !== null &&
    !Array.isArray((clonedDb as Record<string, JsonValue>).priorities)
  ) {
    const rest: Record<string, JsonValue> = { ...(clonedDb as Record<string, JsonValue>) };
    delete rest.instances;
    return { ...rest, rules: clonedRules };
  }
  return {
    '.pyricRtdbPersistence': 1,
    data: clonedDb,
    priorities: {},
    rules: clonedRules,
  };
}

/** Extract secondary Realtime Database envelopes from a full-state database value. */
export function extractDatabaseInstances(database: JsonValue): Record<string, JsonValue> {
  if (database === null || typeof database !== 'object' || Array.isArray(database)) return {};
  const record = database as Record<string, JsonValue>;
  if (record['.pyricRtdbPersistence'] !== 1) return {};
  const rawInstances = record.instances;
  if (rawInstances === null || typeof rawInstances !== 'object' || Array.isArray(rawInstances)) return {};
  return rawInstances as Record<string, JsonValue>;
}
