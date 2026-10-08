/**
 * Normalizes plane traces and compares them.
 *
 * Three things legitimately differ between planes and are replaced before
 * comparison: the uid an anonymous sign-in mints, the random suffix of a push
 * key, and the instant a server timestamp resolves to. Nothing else is
 * normalized.
 */
import type { Trace } from './interpreter.js';

const PUSH_KEY = /(?<![-0-9A-Za-z_])-[-0-9A-Za-z_]{19}(?![-0-9A-Za-z_])/g;
/** Any instant after 2001; sequences never write numbers this large themselves. */
const TIMESTAMP_FLOOR = 1e12;

function rewrite(value: unknown, text: (input: string) => string): unknown {
  if (typeof value === 'string') return text(value);
  if (typeof value === 'number') return value >= TIMESTAMP_FLOOR ? '<timestamp>' : value;
  if (Array.isArray(value)) return value.map((item) => rewrite(item, text));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[text(key)] = rewrite(child, text);
    return out;
  }
  return value;
}

function collectPushKeys(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PUSH_KEY)) into.add(match[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPushKeys(item, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectPushKeys(key, into);
      collectPushKeys(child, into);
    }
  }
}

export interface NormalTrace {
  steps: unknown[];
  events: Record<string, unknown[]>;
  data: unknown[];
}

export function normalize(trace: Trace): NormalTrace {
  const anonymousNames = new Map(trace.anonymous.map((uid, index) => [uid, `<anonymous${index}>`]));
  const withoutUids = (input: string): string => {
    let out = input;
    for (const [uid, name] of anonymousNames) out = out.split(uid).join(name);
    return out;
  };
  const keys = new Set<string>(trace.pushed);
  collectPushKeys(rewrite([trace.steps, trace.events, trace.data], withoutUids), keys);
  // Each plane's push keys increase with the time they were minted at, so
  // their sorted order is the order the sequence pushed them in.
  const pushNames = new Map([...keys].sort().map((key, index) => [key, `<push${index}>`]));
  const text = (input: string): string =>
    withoutUids(input).replace(PUSH_KEY, (match) => pushNames.get(match) ?? match);
  return {
    steps: rewrite(trace.steps, text) as unknown[],
    events: rewrite(trace.events, text) as Record<string, unknown[]>,
    data: rewrite(trace.data, text) as unknown[],
  };
}

export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, child) => {
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      return Object.fromEntries(Object.entries(child).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return child;
  });
}

export interface Mismatch {
  /** Where the planes first disagree, such as `steps[3]` or `events.L0 value db0 /items`. */
  where: string;
  values: Record<string, unknown>;
}

/** The first disagreement between named, normalized traces, or null when they agree. */
export function firstMismatch(
  traces: Record<string, NormalTrace>,
  tolerated: (mismatch: Mismatch) => boolean = () => false,
): Mismatch | null {
  const names = Object.keys(traces);
  const reference = traces[names[0]!]!;
  const locations: Array<[string, (trace: NormalTrace) => unknown]> = [];
  for (let i = 0; i < reference.steps.length; i++) locations.push([`steps[${i}]`, (trace) => trace.steps[i]]);
  const listenerNames = new Set(names.flatMap((name) => Object.keys(traces[name]!.events)));
  for (const listener of [...listenerNames].sort()) {
    locations.push([`events.${listener}`, (trace) => trace.events[listener]]);
  }
  for (let i = 0; i < reference.data.length; i++) locations.push([`data[${i}]`, (trace) => trace.data[i]]);
  for (const [where, read] of locations) {
    const values = Object.fromEntries(names.map((name) => [name, read(traces[name]!)]));
    const encoded = new Set(Object.values(values).map(stable));
    if (encoded.size > 1 && !tolerated({ where, values })) return { where, values };
  }
  return null;
}
