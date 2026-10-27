/**
 * Compares a scenario's replay with its production observation, key by key.
 *
 * Each top-level behavior key must match production, unless a pin names it.
 * A pin names its hunt finding and both answers: production's value from the
 * observation and pyric's value today. Pinned keys must match both, so the
 * suite stays green until either side moves. The fix for a finding deletes
 * its pin. `deepEqual` follows bun's `toEqual` closely enough for JSON data.
 */
export type Behavior = Record<string, unknown>;

export interface Pin {
  key: string;
  finding: string;
  production: unknown;
  pyric: unknown;
}

export interface Replay {
  production: Behavior;
  pyric: Behavior;
  /** Keys pyric gets wrong today, each pinned on both sides. */
  pins?: Pin[];
  /** Keys left out of the comparison, each with its reason. */
  notCompared?: Record<string, string>;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  const bothObjects = typeof left === 'object' && typeof right === 'object' && left !== null && right !== null;
  if (!bothObjects) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).filter((key) => (left as Behavior)[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => (right as Behavior)[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => deepEqual((left as Behavior)[key], (right as Behavior)[key]));
}

const show = (value: unknown) => JSON.stringify(value);

/** Every disagreement, as readable lines. Empty when the replay holds. */
export function replayMismatches({ production, pyric, pins = [], notCompared = {} }: Replay): string[] {
  const problems: string[] = [];
  const pinned = new Map(pins.map((pin) => [pin.key, pin]));
  for (const key of Object.keys(production)) {
    if (key in notCompared) continue;
    const pin = pinned.get(key);
    if (!pin) {
      if (!deepEqual(pyric[key], production[key])) problems.push(`${key}: pyric ${show(pyric[key])}, production ${show(production[key])}`);
      continue;
    }
    if (!deepEqual(production[key], pin.production)) problems.push(`${key} (${pin.finding}): production is ${show(production[key])}, the pin says ${show(pin.production)}`);
    if (!deepEqual(pyric[key], pin.pyric)) problems.push(`${key} (${pin.finding}): pyric is ${show(pyric[key])}, the pin says ${show(pin.pyric)}`);
  }
  for (const pin of pins) {
    if (!(pin.key in production)) problems.push(`${pin.key}: pinned, but the observation does not record it`);
  }
  return problems;
}

/**
 * Drop every `message` field. Error text differs between the backend and the
 * sandbox (FL-19, severity 4); the codes and outcomes are what replays compare.
 */
export function withoutMessages<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutMessages) as T;
  if (value === null || typeof value !== 'object') return value;
  const kept = Object.entries(value as Behavior).filter(([key]) => key !== 'message');
  return Object.fromEntries(kept.map(([key, inner]) => [key, withoutMessages(inner)])) as T;
}

/**
 * Found while replaying these captures, outside the hunt's findings: a
 * metadata listener on data this client just wrote first gets a snapshot from
 * the local cache (fromCache true), then the server one. The sandbox sends one.
 */
export const CACHED_INITIAL_SNAPSHOT = '#1355: the first snapshot of locally written data comes from the cache, then the server';
