/**
 * Shared harness for the RTDB rules standard library tests.
 *
 * A scenario is one ruleset built from standard library builders plus the
 * requests that exercise it. Every case runs twice: through
 * `rtdbRules(definition).simulate` (an `update` case goes through the
 * compiled-rules simulator with its multi-path `updates`, which the public
 * case shape does not carry), and through a fresh sandbox that deploys the
 * compiled JSON, seeds `data` past the rules, and performs the request with
 * the client SDK. Both must give the case's expectation.
 */
import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  get,
  goOffline,
  onDisconnect,
  ref,
  sandbox,
  serverTimestamp,
  set,
  update,
} from 'pyric/database';
import { defineRtdbRules, rtdbRules, type PathDef } from 'pyric/rules';
import { compileRtdbRules, simulateRtdbRules } from '../../../../src/rules/rtdb/compiled-rules.js';

export type Verdict = 'ALLOW' | 'DENY';

export interface StdlibCase {
  description: string;
  expectation: Verdict;
  operation: 'read' | 'write' | 'update';
  /** Absolute path of the request. */
  path: string;
  /** Signed-in uid, or null for a signed-out request. */
  auth: string | null;
  /** The database tree before the request, from the root. */
  data?: Record<string, unknown>;
  /** The value a write sets, or an update's patch keyed by relative paths. */
  newData?: unknown;
  /**
   * Paths in `newData` (relative to `path`, '' for `newData` itself) that the
   * client writes as the server timestamp. The simulator receives the
   * evaluation instant at those paths and as `now`.
   */
  serverTime?: string[];
  /**
   * Register the write as an onDisconnect operation and run it by going
   * offline. The verdict is the registration's; a registered write that runs
   * must leave `newData` at `path`.
   */
  onDisconnect?: boolean;
}

/** Builder paths, or compiled `{ rules }` JSON such as a corpus scenario deploys. */
export type StdlibScenario =
  | { paths: Record<string, PathDef>; cases: StdlibCase[] }
  | { json: { rules: Record<string, unknown> }; cases: StdlibCase[] };

const compiledJson = new WeakMap<StdlibScenario, { rules: Record<string, unknown> }>();

function rulesJson(scenario: StdlibScenario): { rules: Record<string, unknown> } {
  if ('json' in scenario) return scenario.json;
  let json = compiledJson.get(scenario);
  if (!json) {
    json = rtdbRules(defineRtdbRules({ paths: scenario.paths })).toJSON() as { rules: Record<string, unknown> };
    compiledJson.set(scenario, json);
  }
  return json;
}

// One handle per ruleset: compiling a long expression takes a measurable
// fraction of a second, and every case of a scenario shares the ruleset.
const handles = new WeakMap<object, ReturnType<typeof rtdbRules>>();
const compiledRules = new WeakMap<object, ReturnType<typeof compileRtdbRules>>();

function handleFor(scenario: StdlibScenario): ReturnType<typeof rtdbRules> {
  const json = rulesJson(scenario);
  let handle = handles.get(json);
  if (!handle) {
    handle = rtdbRules(json);
    handles.set(json, handle);
  }
  return handle;
}

function compiledFor(scenario: StdlibScenario): ReturnType<typeof compileRtdbRules> {
  const json = rulesJson(scenario);
  let compiled = compiledRules.get(json);
  if (!compiled) {
    compiled = compileRtdbRules(json);
    compiledRules.set(json, compiled);
  }
  return compiled;
}

function setAt(root: Record<string, unknown>, path: string, value: unknown): unknown {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return value;
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = cursor[segments[i]];
    const child = next && typeof next === 'object' ? (next as Record<string, unknown>) : {};
    cursor[segments[i]] = child;
    cursor = child;
  }
  cursor[segments[segments.length - 1]] = value;
  return root;
}

function withServerTime(value: unknown, paths: string[] | undefined, stamp: unknown): unknown {
  if (!paths || paths.length === 0) return value;
  let out: unknown = structuredClone(value);
  for (const p of paths) {
    if (p === '') {
      out = stamp;
    } else if (out && typeof out === 'object' && p in out) {
      // An update patch key, such as 'lastPost/alice'.
      (out as Record<string, unknown>)[p] = stamp;
    } else {
      out = setAt((out ?? {}) as Record<string, unknown>, p, stamp);
    }
  }
  return out;
}

/** The simulator's verdict for one case. */
export function simulateCase(scenario: StdlibScenario, c: StdlibCase): Verdict | 'UNSUPPORTED' {
  const now = Date.now();
  const newData = withServerTime(c.newData, c.serverTime, now);
  if (c.operation === 'update') {
    const compiled = compiledFor(scenario);
    const updates = Object.entries(newData as Record<string, unknown>).map(([key, value]) => ({
      path: `${c.path}/${key}`.replace(/\/+/g, '/'),
      value,
    }));
    const verdicts = updates.map(({ path, value }) => {
      const result = simulateRtdbRules(compiled, {
        operation: 'write',
        path,
        auth: c.auth === null ? null : { uid: c.auth, token: {} },
        mockData: c.data ?? {},
        newData: value,
        updates,
        now,
      });
      if (!result.success || result.data.unsupported) return 'UNSUPPORTED' as const;
      return result.data.allowed ? ('ALLOW' as const) : ('DENY' as const);
    });
    if (verdicts.includes('UNSUPPORTED')) return 'UNSUPPORTED';
    return verdicts.every((v) => v === 'ALLOW') ? 'ALLOW' : 'DENY';
  }
  const [result] = handleFor(scenario).simulate([
    {
      description: c.description,
      expectation: c.expectation,
      operation: c.operation,
      path: c.path,
      auth: c.auth,
      data: c.data ?? {},
      ...(c.operation === 'write' ? { newData } : {}),
      now,
    },
  ]).cases;
  return result.decision;
}

/** The sandbox's verdict for one case. */
export async function sandboxCase(scenario: StdlibScenario, c: StdlibCase): Promise<Verdict> {
  const box = initializeSandbox();
  const admin = getDatabase(box.withAuth({ uid: 'stdlib-admin' }));
  sandbox.setRules(admin, rulesJson(scenario));
  if (c.data && Object.keys(c.data).length > 0) sandbox.setData(admin, { '/': c.data });
  const db = getDatabase(c.auth === null ? box : box.withAuth({ uid: c.auth }));
  const newData = withServerTime(c.newData, c.serverTime, serverTimestamp());
  const target = ref(db, c.path);
  try {
    if (c.operation === 'read') await get(target);
    else if (c.operation === 'update') await update(target, newData as Record<string, unknown>);
    else if (c.onDisconnect) await onDisconnect(target).set(newData);
    else await set(target, newData);
  } catch {
    return 'DENY';
  }
  if (c.onDisconnect) {
    // The registered write runs when the connection drops, and the server
    // checks the rules again then. It must land.
    goOffline(db);
    let stored: unknown = sandbox.snapshotState(admin);
    for (const segment of c.path.split('/').filter(Boolean)) {
      stored = stored && typeof stored === 'object' ? (stored as Record<string, unknown>)[segment] : undefined;
    }
    expect(stored === undefined || stored === null).toBe(c.newData === null);
  }
  return 'ALLOW';
}

/** Registers one test per case asserting simulate and the sandbox agree with the expectation. */
export function runScenario(scenario: StdlibScenario): void {
  const json = handleFor(scenario);
  test('the ruleset compiles without lint errors', () => {
    expect(json.lint().filter((issue) => issue.severity === 'error')).toEqual([]);
  });
  for (const c of scenario.cases) {
    test(`${c.expectation}: ${c.description}`, async () => {
      expect(simulateCase(scenario, c)).toBe(c.expectation);
      expect(await sandboxCase(scenario, c)).toBe(c.expectation);
    });
  }
}
