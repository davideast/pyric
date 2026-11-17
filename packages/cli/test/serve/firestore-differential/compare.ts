/**
 * Normalizes and compares Firestore differential traces across execution planes.
 *
 * Only genuinely per-plane nondeterministic tokens are normalized:
 * 1. Anonymous Auth UIDs minted by `signInAnonymously()` -> `<anon0>`, ...
 * 2. Auto-generated document IDs minted by `addDoc()` -> `<auto0>`, ...
 * 3. Server timestamps (already tagged `{ $t: 'serverTimestamp' }` during read
 *    canonicalization when `seconds >= SERVER_TIMESTAMP_FLOOR_SECONDS`).
 */

export type StepOutcome = { ok: unknown } | { error: string };

export interface Trace {
  seed: number;
  steps: StepOutcome[];
  events: Record<string, unknown[]>;
  clientData: unknown[];
  adminData: Record<string, unknown>;
  bundleData: Record<string, unknown>;
  anonymousUids: string[];
  autoIds: string[];
}

export interface NormalTrace {
  steps: unknown[];
  events: Record<string, unknown[]>;
  clientData: unknown[];
  adminData: Record<string, unknown>;
  bundleData: Record<string, unknown>;
  bundleMatchesAdmin: boolean;
}

export interface Mismatch {
  where: string;
  values: Record<string, unknown>;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function rewriteTokens(value: unknown, replaceText: (text: string) => string): unknown {
  if (typeof value === 'string') {
    return replaceText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteTokens(item, replaceText));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const pairs = Object.entries(value as Record<string, unknown>)
      .map(([key, child]): [string, unknown] => [replaceText(key), rewriteTokens(child, replaceText)])
      .sort(([left], [right]) => compareStrings(left, right));
    for (const [key, child] of pairs) {
      out[key] = child;
    }
    return out;
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, child) => {
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      const sorted = Object.entries(child as Record<string, unknown>)
        .sort(([left], [right]) => compareStrings(left, right));
      return Object.fromEntries(sorted);
    }
    return child;
  });
}

export function normalizeTrace(trace: Trace): NormalTrace {
  const replacements: Array<[string, string]> = [];
  trace.anonymousUids.forEach((uid, index) => {
    if (uid.length > 0) {
      replacements.push([uid, `<anon${index}>`]);
    }
  });
  trace.autoIds.forEach((autoId, index) => {
    if (autoId.length > 0) {
      replacements.push([autoId, `<auto${index}>`]);
    }
  });
  // Replace longer tokens first so one token cannot partially corrupt a longer token.
  replacements.sort(([left], [right]) => right.length - left.length);

  const replaceText = (input: string): string => {
    let out = input;
    for (const [raw, placeholder] of replacements) {
      out = out.split(raw).join(placeholder);
    }
    return out;
  };

  const adminData = rewriteTokens(trace.adminData, replaceText) as Record<string, unknown>;
  const bundleData = rewriteTokens(trace.bundleData, replaceText) as Record<string, unknown>;
  const bundleMatchesAdmin = stableJson(bundleData) === stableJson(adminData);

  return {
    steps: rewriteTokens(trace.steps, replaceText) as unknown[],
    events: rewriteTokens(trace.events, replaceText) as Record<string, unknown[]>,
    clientData: rewriteTokens(trace.clientData, replaceText) as unknown[],
    adminData,
    bundleData,
    bundleMatchesAdmin,
  };
}

export function firstMismatch(
  traces: Record<string, NormalTrace>,
  tolerated: (mismatch: Mismatch) => boolean = () => false,
): Mismatch | null {
  const names = Object.keys(traces);
  const firstName = names[0];
  if (firstName === undefined) {
    return null;
  }
  const reference = traces[firstName];
  if (reference === undefined) {
    return null;
  }

  const locations: Array<[string, (trace: NormalTrace) => unknown]> = [];
  for (let i = 0; i < reference.steps.length; i++) {
    locations.push([`steps[${i}]`, (trace) => trace.steps[i]]);
  }
  const listenerNames = new Set<string>();
  for (const name of names) {
    const planeTrace = traces[name];
    if (planeTrace !== undefined) {
      for (const key of Object.keys(planeTrace.events)) {
        listenerNames.add(key);
      }
    }
  }
  for (const listener of [...listenerNames].sort()) {
    locations.push([`events.${listener}`, (trace) => trace.events[listener]]);
  }
  for (let i = 0; i < reference.clientData.length; i++) {
    locations.push([`clientData[${i}]`, (trace) => trace.clientData[i]]);
  }
  locations.push(['adminData', (trace) => trace.adminData]);
  locations.push(['bundleData', (trace) => trace.bundleData]);

  // Bundle round-trip invariant: even if both planes somehow produced the same
  // broken bundle, `bundleMatchesAdmin` must be `true` on every plane.
  for (const name of names) {
    const planeTrace = traces[name];
    if (planeTrace !== undefined && !planeTrace.bundleMatchesAdmin) {
      const candidate: Mismatch = {
        where: `bundleRoundTrip.${name}`,
        values: {
          [`${name}.adminData`]: planeTrace.adminData,
          [`${name}.bundleData`]: planeTrace.bundleData,
        },
      };
      if (!tolerated(candidate)) {
        return candidate;
      }
    }
  }

  for (const [where, read] of locations) {
    const values: Record<string, unknown> = {};
    for (const name of names) {
      const planeTrace = traces[name];
      if (planeTrace === undefined) {
        values[name] = undefined;
      } else {
        values[name] = read(planeTrace);
      }
    }
    const distinct = new Set(Object.values(values).map(stableJson));
    if (distinct.size > 1) {
      const candidate: Mismatch = { where, values };
      if (!tolerated(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
