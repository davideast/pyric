/**
 * Oracle conformance (RTDB, `rtdb-*` surface) — wires the frozen
 * `packages/conformance/observations/rtdb/rtdb-*.json` captures into the test suite
 * so the recorded real-Firebase-RTDB behavior is MACHINE-CHECKED against
 * the in-process sandbox, not just cited in comments (mirrors the auth
 * suite at `test/auth/oracle-conformance.test.ts` — see that file's
 * header for the H5/H6 rationale, and the storage suite for how a
 * transport-scoped capture is adapted or pinned as a divergence).
 *
 * This file covers the NON-modular `rtdb-*` observations; the
 * `rtdb-modular-*` captures are covered by
 * `test/database/modular/oracle-conformance.test.ts`. The completeness
 * test at the bottom filters to `rtdb-*` MINUS `rtdb-modular-*` so the
 * two suites partition the RTDB observation set.
 *
 * Pattern: each test loads its observation and replays the scenario
 * against the sandbox's modular RTDB surface (the only in-process RTDB
 * shim — the `rtdb-*` rowIds themselves reference `rtdb-modular#…` matrix
 * rows), asserting the environment-independent facts the capture
 * recorded (fire counts, error codes, orderings, null-ness, booleans).
 * The JSON's values are the EXPECTED side wherever sensible. Prod-
 * specific noise (real auto-ids, wall-clock timestamps, elapsed-ms
 * numbers, HTML redirector bytes) is NOT asserted.
 *
 * Adaptations from the template:
 *   - Several `rtdb-*` captures record REST/transport shape (`.json`
 *     suffix, `?shallow=true`, `/.settings/rules.json` round-trip) that
 *     the in-process sandbox has no HTTP surface for — those are listed
 *     in NOT_APPLICABLE with a precise reason.
 *   - Where a capture rode the live REST plane but the fact under test is
 *     an in-scope semantic (admin/user read agreement, rules-deploy
 *     propagation), the closest sandbox equivalent stands in and the
 *     substitution is called out per-test.
 *   - Where the sandbox CONTRADICTS a capture, BOTH sides are pinned
 *     (prod value from the JSON + the sandbox's actual behavior) with a
 *     KNOWN DIVERGENCE comment — never weakened to pass.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getDatabase,
  getAdminDatabase,
  ref,
  get,
  set,
  remove,
  push,
  onValue,
  onChildAdded,
  off,
  serverTimestamp,
  sandbox as rtdbSandbox,
} from '../../src/database/index.js';

// rtdb-* (non-modular) observations live under the 'rtdb' surface subdirectory.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'rtdb');

/** Observations that cannot be replayed against the sandbox, with the reason. */
const NOT_APPLICABLE: Record<string, string> = {
  'rtdb-rest-json-suffix-contract.json':
    'REST-transport contract: `<databaseUrl>/<path>.json` returns JSON while the un-suffixed URL returns the Firebase console HTML redirector. The in-process sandbox has no HTTP surface / redirector, so the `.json`-suffix-vs-HTML fact is not replayable (it belongs to `fetchDatabase`, tested at test/database/host.test.ts).',
  'rtdb-shallow-rest-response-shape.json':
    'REST-transport shape: `?shallow=true` collapses object children to `{key: true}`, leaves leaf primitives verbatim, and returns `null` for missing paths. `shallow` is a `fetchDatabase` query param over HTTP; the modular sandbox `get()` returns full values and exposes no shallow read, so the shallow response shape is not replayable in-process.',
  'rtdb-rules-json-roundtrip.json':
    'REST `/.settings/rules.json` PUT/GET round-trip (path-variable segments, `.indexOn`, `.read`/`.write`/`.validate` keys preserved verbatim). The sandbox exposes `sandbox.setRules` (write) but no rules read-back API, so the round-trip structural-preservation fact cannot be observed in-process.',
};

function load(name: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(join(OBS_DIR, name), 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return json.behavior;
}

function setup() {
  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db };
}

const DENY_ALL = { rules: { '.read': 'false', '.write': 'false' } };

describe('oracle conformance (rtdb)', () => {
  // ── round-trips & write equivalence ──────────────────────────────────

  it('rtdb-set-then-get-roundtrip (KNOWN DIVERGENCE: object-key ordering)', async () => {
    // Prod capture: the written value reads back intact BUT
    // `roundTripEqual: false`. RTDB returns object children in
    // LEXICOGRAPHIC key order, so a `JSON.stringify(payload) ===
    // JSON.stringify(readBack)` comparison against a non-sorted payload
    // differs even though the value is structurally identical (the
    // recorded readBack keys — count, hello, ok — are sorted).
    //
    // The sandbox (src/database/sandbox/data-tree.ts) PRESERVES insertion
    // order on read-back, so the same stringify round-trip is `true`. Pin
    // BOTH sides so neither drifts unnoticed: the value round-trips (the
    // environment-independent fact), and the key-ordering divergence.
    const obs = load('rtdb-set-then-get-roundtrip.json');
    const { db } = setup();
    // Write with a deliberately NON-sorted insertion order (hello, count, ok).
    const payload = { hello: 'world', count: 42, ok: true };
    await set(ref(db, 'pyric_oracle/rt'), payload);
    const readBack = (await get(ref(db, 'pyric_oracle/rt'))).val() as Record<string, unknown>;

    // Environment-independent fact: the value round-trips structurally.
    expect(readBack).toEqual(obs.readBack as Record<string, unknown>);

    // Prod (the target): a stringify round-trip is FALSE because RTDB
    // reorders keys lexicographically.
    expect(obs.roundTripEqual).toBe(false);
    // Sandbox today: keys keep insertion order → stringify round-trip is TRUE.
    expect(Object.keys(readBack)).toEqual(['hello', 'count', 'ok']);
    expect(JSON.stringify(payload) === JSON.stringify(readBack)).toBe(true);
  });

  it('rtdb-remove-vs-set-null', async () => {
    const obs = load('rtdb-remove-vs-set-null.json');
    const a = setup();
    const b = setup();
    await set(ref(a.db, 'x'), { a: 1, b: 2 });
    await set(ref(b.db, 'x'), { a: 1, b: 2 });
    await remove(ref(a.db, 'x'));
    await set(ref(b.db, 'x'), null);
    const afterRemove = (await get(ref(a.db, 'x'))).val();
    const afterSetNull = (await get(ref(b.db, 'x'))).val();
    expect(afterRemove).toBe(obs.afterRemove as null);
    expect(afterSetNull).toBe(obs.afterSetNull as null);
    expect(afterRemove === null && afterSetNull === null).toBe(obs.bothNull as boolean);
    expect(afterRemove === afterSetNull).toBe(obs.equivalent as boolean);
  });

  it('rtdb-servertimestamp-resolves (registry-excepted; replayable here)', async () => {
    // Registry `observationExceptions` excepts this from the matrix
    // (deny-listed sentinel family), but the underlying behavior — the
    // `{ ".sv": "timestamp" }` sentinel resolves to a numeric ms on
    // read-back — IS in the sandbox surface, so we replay it. The literal
    // recorded timestamp is wall-clock noise; only the type is asserted.
    const obs = load('rtdb-servertimestamp-resolves.json');
    const { db } = setup();
    await set(ref(db, 'pyric_oracle/meta'), { createdAt: serverTimestamp(), label: 'hello' });
    const v = (await get(ref(db, 'pyric_oracle/meta'))).val() as {
      createdAt: unknown;
      label: string;
    };
    expect(typeof v.createdAt).toBe(obs.createdAtType as string);
    expect(typeof v.createdAt === 'number').toBe(obs.createdAtIsNumber as boolean);
    // Not the raw sentinel object.
    expect(
      typeof v.createdAt === 'object' && v.createdAt !== null && '.sv' in (v.createdAt as object),
    ).toBe(obs.createdAtSentinelShape as boolean);
    expect(v.label).toBe((obs.readBack as { label: string }).label);
  });

  // ── auto-ids ─────────────────────────────────────────────────────────

  it('rtdb-push-autoid-format', () => {
    const obs = load('rtdb-push-autoid-format.json');
    const { db } = setup();
    const keys = [push(ref(db, 'items')).key!, push(ref(db, 'items')).key!, push(ref(db, 'items')).key!];
    // Structural facts only — the recorded sampleKeys are prod noise.
    expect(keys.map((k) => k.length)).toEqual(obs.lengths as number[]);
    expect(keys.every((k) => k.length === 20)).toBe(obs.allLength20 as boolean);
    expect(keys.every((k) => k.startsWith('-'))).toBe(obs.allStartWithDash as boolean);
    expect(keys[0]! < keys[1]! && keys[1]! < keys[2]!).toBe(obs.monotonicallySorted as boolean);
  });

  // ── listener semantics ───────────────────────────────────────────────

  it('rtdb-onvalue-fires-on-set (registry-excepted; replayable here)', async () => {
    // Registry `observationExceptions` excepts this (deny-listed listener
    // family), but the modular sandbox implements `onValue`, so we replay
    // the fire-count + value sequence. The recorded per-fire `ts` values
    // are wall-clock noise and are NOT asserted.
    const obs = load('rtdb-onvalue-fires-on-set.json');
    const { db } = setup();
    const vals: unknown[] = [];
    const unsub = onValue(ref(db, 'pyric_oracle/c'), (snap) => vals.push(snap.val()));
    expect(vals.length).toBe(obs.initialFires as number); // 1 — initial fire
    await set(ref(db, 'pyric_oracle/c'), { v: 1 });
    expect(vals.length).toBe(obs.firesAfterFirstSet as number); // 2
    await set(ref(db, 'pyric_oracle/c'), { v: 2 });
    expect(vals.length).toBe(obs.firesAfterSecondSet as number); // 3
    // The recorded `fires[*].val` sequence (ts stripped).
    const recordedVals = (obs.fires as Array<{ val: unknown }>).map((f) => f.val);
    expect(vals).toEqual(recordedVals); // [null, {v:1}, {v:2}]
    unsub();
  });

  it('rtdb-onvalue-unsub-equivalence', async () => {
    const obs = load('rtdb-onvalue-unsub-equivalence.json');
    // Branch A — the returned unsubscribe stops the listener.
    const a = setup();
    let firesA = 0;
    const unsub = onValue(ref(a.db, 'v'), () => { firesA++; });
    expect(typeof unsub).toBe(obs.unsubReturnType as string); // 'function'
    expect(typeof unsub === 'function').toBe(obs.unsubIsFunction as boolean);
    expect(firesA).toBe(obs.initialFiresA as number); // 1
    await set(ref(a.db, 'v'), 1);
    expect(firesA).toBe(obs.afterWriteFiresA as number); // 2
    unsub();
    await set(ref(a.db, 'v'), 2);
    expect(firesA).toBe(obs.afterUnsubFiresA as number); // 2 — stopped
    expect(firesA === (obs.afterWriteFiresA as number)).toBe(
      obs.unsubReturnedFnStopsListener as boolean,
    );

    // Branch B — off(ref, 'value', cb) stops the same registration (same
    // callback identity is required, so a named fn stands in for the
    // inline arrow used in branch A).
    const b = setup();
    let firesB = 0;
    const cb = (): void => { firesB++; };
    onValue(ref(b.db, 'v'), cb);
    expect(firesB).toBe(obs.initialFiresB as number); // 1
    await set(ref(b.db, 'v'), 1);
    expect(firesB).toBe(obs.afterWriteFiresB as number); // 2
    off(ref(b.db, 'v'), 'value', cb);
    await set(ref(b.db, 'v'), 2);
    expect(firesB).toBe(obs.afterOffFiresB as number); // 2 — stopped
    expect(firesB === (obs.afterWriteFiresB as number)).toBe(
      obs.offRefValueCbStopsListener as boolean,
    );
    expect(true).toBe(obs.bothFormsEquivalent as boolean);
  });

  it('rtdb-off-eventtype-precision', async () => {
    // `off(ref, 'value')` clears ALL value listeners at the ref but leaves
    // child listeners firing; `off(ref, 'child_added')` then stops the
    // child listener. Recorded counts: two value listeners (v1, v2) + one
    // child listener (c).
    const obs = load('rtdb-off-eventtype-precision.json');
    const { db } = setup();
    // Seed one existing child so onChildAdded replays exactly 1 on subscribe.
    await set(ref(db, 'p/k0'), { v: 0 });

    let v1 = 0;
    let v2 = 0;
    let c = 0;
    onValue(ref(db, 'p'), () => { v1++; });
    onValue(ref(db, 'p'), () => { v2++; });
    onChildAdded(ref(db, 'p'), () => { c++; });
    expect({ v1, v2, c }).toEqual(obs.initial as Record<string, number>); // {1,1,1}

    await set(ref(db, 'p/k1'), { v: 1 }); // value fires (both) + child_added (k1)
    expect({ v1, v2, c }).toEqual(obs.afterFirstWrite as Record<string, number>); // {2,2,2}

    off(ref(db, 'p'), 'value'); // clears BOTH value listeners in one call
    await set(ref(db, 'p/k2'), { v: 2 }); // only child_added fires (k2)
    expect({ v1, v2, c }).toEqual(obs.afterOffValue as Record<string, number>); // {2,2,3}

    off(ref(db, 'p'), 'child_added');
    await set(ref(db, 'p/k3'), { v: 3 }); // nothing fires
    expect({ v1, v2, c }).toEqual(obs.afterOffChild as Record<string, number>); // {2,2,3}

    expect(v1 === 2 && v2 === 2).toBe(obs.valueListenersStopped as boolean);
    expect(obs.offValueClearsAllValueListeners as boolean).toBe(true);
    expect(obs.childListenerStillFiringAfterOffValue as boolean).toBe(true);
    expect(obs.childListenerStoppedAfterOffChild as boolean).toBe(true);
  });

  // ── rules ────────────────────────────────────────────────────────────

  it('rtdb-rules-denied-error-code', async () => {
    const obs = load('rtdb-rules-denied-error-code.json');
    const { db } = setup();
    rtdbSandbox.setRules(db, DENY_ALL);
    let caught: unknown;
    try {
      await set(ref(db, 'forbidden'), 'x');
    } catch (e) {
      caught = e;
    }
    expect(caught !== undefined).toBe(obs.threw as boolean);
    expect(caught instanceof Error).toBe(obs.isErrorInstance as boolean);
    const err = caught as Error & { code: string };
    expect(err.code).toBe(obs.code as string); // 'PERMISSION_DENIED'
    expect(err.message).toBe(obs.message as string); // 'PERMISSION_DENIED: Permission denied'
    expect(err.name).toBe(obs.errorName as string); // 'Error'
    expect(err.constructor.name).toBe(obs.constructorName as string); // 'Error' (plain, not FirebaseError)
  });

  it('rtdb-rules-deploy-propagation-timing (substitution: synchronous setRules)', async () => {
    // Prod capture: a fresh permissive rule takes effect and a dependent
    // write succeeds — the wall-clock upper bound the harness measured was
    // 177ms (well within 5s/10s). The sandbox deploys rules synchronously
    // via `sandbox.setRules`, so propagation is instant; the elapsed-ms
    // literal is prod-timing noise and is NOT asserted. We replay the
    // structural facts: a write is denied under the baseline deny rule,
    // then succeeds once the permissive rule is deployed, within bounds.
    const obs = load('rtdb-rules-deploy-propagation-timing.json');
    const { db } = setup();
    rtdbSandbox.setRules(db, DENY_ALL);
    let baselineThrew = false;
    let baselineCode: string | undefined;
    try {
      await set(ref(db, 'pyric_oracle/prop'), 1);
    } catch (e) {
      baselineThrew = true;
      baselineCode = (e as { code?: string }).code;
    }
    expect(baselineThrew).toBe(obs.baselineDenied as boolean);
    expect(baselineCode).toBe(obs.baselineCode as string); // 'PERMISSION_DENIED'

    // Deploy a permissive rule; the dependent write now lands.
    rtdbSandbox.setRules(db, { rules: { '.read': 'true', '.write': 'true' } });
    let putOk = true;
    try {
      await set(ref(db, 'pyric_oracle/prop'), 1);
    } catch {
      putOk = false;
    }
    expect(putOk).toBe(obs.putOk as boolean);
    // Instant propagation ⇒ trivially within the recorded bounds.
    expect(obs.within5s).toBe(true);
    expect(obs.within10s).toBe(true);
  });

  it('rtdb-simulator-vs-prod-agreement (CONFORMS: `.validate` now enforced)', async () => {
    // Prod capture: an allow/deny audit of the pyric rule simulator vs
    // live RTDB across 29 ops found 28 agreements and exactly 1
    // disagreement — `r4-validate-structure`'s "missing body denied": prod
    // DENIES the write (its `.validate` fails) while the simulator at
    // capture time ALLOWED it (it evaluated only `.write`). The sandbox
    // now runs the `.validate` walk on writes, closing the divergence; the
    // frozen audit facts below document the historical disagreement.
    const obs = load('rtdb-simulator-vs-prod-agreement.json');
    // Environment-independent audit facts recorded against the sandbox's
    // own simulator.
    expect(obs.totalOps).toBe(29);
    expect(obs.agreements).toBe(28);
    expect(obs.disagreements).toBe(1);
    const divs = obs.divergences as Array<Record<string, unknown>>;
    expect(divs.length).toBe(1);
    expect(divs[0]!.ruleId).toBe('r4-validate-structure');
    expect(divs[0]!.operation).toBe('write');
    expect(divs[0]!.prodAllowed).toBe(false); // prod: validate denies
    expect(divs[0]!.simAllowed).toBe(true); // sandbox sim: allows
    expect(divs[0]!.agree).toBe(false);

    // Replay the once-divergent case live through the sandbox write path
    // (same rule engine the audit exercised): a `.validate`-requiring rule
    // now DENIES the structurally-invalid write, matching prod's recorded
    // `prodAllowed: false` (`.validate` walk in
    // src/database/simulation/handler.ts, reached from all backend write
    // sites).
    const { sandbox, db } = setup();
    rtdbSandbox.setRules(db, {
      rules: {
        entry: {
          '.write': 'auth != null',
          '.validate': "newData.hasChildren(['body'])",
        },
      },
    });
    let thrown: unknown;
    try {
      await set(ref(db, 'entry'), { notBody: 1 }); // missing required `body`
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe('PERMISSION_DENIED');
    // The invalid value was not committed (admin read bypasses the rules,
    // which grant no `.read` here).
    const after = await get(ref(getAdminDatabase(sandbox), 'entry'));
    expect(after.val()).toBeNull();
  });

  // ── admin/user return-shape agreement ────────────────────────────────

  it('rtdb-handler-admin-vs-user-returnshape (substitution: getAdminDatabase vs getDatabase)', async () => {
    // Prod capture drove the agent-tool `DataHandler.execute()` (a REST-
    // plane surface out of the sandbox's v1 scope) in admin mode (no auth)
    // and user mode (anonymous auth) and locked that both return
    // `{ success: true, data: <value> }` with the SAME value. The in-scope
    // equivalent is a read through the rule-bypass admin handle
    // (`getAdminDatabase`) vs the identity-bound user handle
    // (`getDatabase(withAuth)`) sharing one backend: the fact under test —
    // admin and user reads succeed and agree on the value — is preserved;
    // only the `{ success, data }` wrapper (a handler concern) differs.
    const obs = load('rtdb-handler-admin-vs-user-returnshape.json');
    const sandbox = initializeSandbox();
    const userDb = getDatabase(sandbox.withAuth({ uid: 'anon' }));
    const adminDb = getAdminDatabase(sandbox);
    const payload = { hello: 'handler', n: 7 };
    await set(ref(userDb, 'pyric_oracle/h'), payload);

    let adminError: unknown = null;
    let userError: unknown = null;
    let adminData: unknown;
    let userData: unknown;
    try {
      adminData = (await get(ref(adminDb, 'pyric_oracle/h'))).val();
    } catch (e) {
      adminError = e;
    }
    try {
      userData = (await get(ref(userDb, 'pyric_oracle/h'))).val();
    } catch (e) {
      userError = e;
    }
    expect(adminError).toBe(obs.adminError as null);
    expect(userError).toBe(obs.userError as null);
    expect(adminError === null).toBe(obs.adminSuccess as boolean);
    expect(userError === null).toBe(obs.userSuccess as boolean);
    expect(adminData).toEqual(obs.adminData as Record<string, unknown>);
    expect(userData).toEqual(obs.userData as Record<string, unknown>);
    expect(JSON.stringify(adminData) === JSON.stringify(payload)).toBe(
      obs.adminDataMatchesPayload as boolean,
    );
    expect(JSON.stringify(userData) === JSON.stringify(payload)).toBe(
      obs.userDataMatchesPayload as boolean,
    );
    expect(JSON.stringify(adminData) === JSON.stringify(userData)).toBe(obs.shapesAgree as boolean);
  });

  // ── completeness: every `rtdb-*` (non-modular) observation is covered ──

  it('every rtdb (non-modular) observation is covered (no silent gaps)', () => {
    const all = readdirSync(OBS_DIR).filter(
      (f) => f.startsWith('rtdb-') && !f.startsWith('rtdb-modular-') && f.endsWith('.json'),
    );
    expect(all.length).toBe(14);
    const source = readFileSync(import.meta.path, 'utf8');
    const uncovered = all.filter(
      (f) => !source.includes(f.replace('.json', '')) && !(f in NOT_APPLICABLE),
    );
    expect(uncovered).toEqual([]);
  });
});
