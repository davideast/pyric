/**
 * Rules-failure debugging: pure-logic tests (Pyric Studio F4).
 *
 * Drives the denial→rule→context model and the two re-run helpers against REAL
 * pyric sandboxes (Firestore + RTDB), with no browser/DOM, plus Storage's
 * gap-as-spec (no denial event exists to project yet — see `SPEC.md`). We:
 *   1. FIRESTORE: deploy owner-gated rules, attempt a write that DENIES, and
 *      assert `selectDenials` / `explainDenial` project the rule, auth, and
 *      path/op the panel renders. Then exercise both re-run paths.
 *   2. RTDB: deploy a `.write` rule that denies, and separately a `.validate`
 *      rule that rejects the proposed value, and assert `explainDenial`
 *      surfaces the exact node (`.write` vs `.validate`), its raw rule text,
 *      and the `$variable` bindings from `SimulateHandler`'s verdict —
 *      exactly what `RtdbRuleDetail` renders.
 *   3. `rerunSupport`: Firestore is `live` on both paths; RTDB is `pending`
 *      naming `rtdb_simulate_access`; Storage is `absent` naming
 *      `storage_simulate_rules` (+ the missing denial-event emitter).
 *   4. LINT-GATING: `rerunAgainstRules` short-circuits on an unparseable
 *      candidate ruleset (the only hard blocker) but proceeds — surfacing the
 *      finding — past a non-parse security lint.
 */

import { describe, it, expect } from 'bun:test';
import {
  initializeSandbox,
  type SandboxEvent,
} from 'pyric/sandbox';
import { bindOperationContext } from 'pyric/sandbox/internal';
import {
  getAdminFirestore,
  getFirestore as getRulesFirestore,
} from 'pyric/sandbox/admin-firestore';
import { getFirestore as getSandboxFirestore, doc, setDoc, collection, query, getDocs } from 'pyric/firestore';
import { getDatabase, ref, set, sandbox as rtdbSandbox } from 'pyric/database';
import {
  selectDenials,
  selectRuleEvaluations,
  explainDenial,
  denialSeverity,
  projectTraceSteps,
  ruleVariables,
  type Denial,
} from './model.js';
import {
  rerunAgainstRules,
  rerunAsUser,
  issueOp,
  lintEditedRuleset,
  type ImpersonationClient,
} from './rerun.js';
import { findRtdbRuleLine } from './RulesDebug.js';

const OWNER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null && request.resource.data.owner == request.auth.uid;
    }
  }
}`;

const PERMISSIVE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

// A security-level lint finding (recursive open wildcard) that still PARSES:
// the edited-ruleset re-run must surface this but not block on it.
const RECURSIVE_OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
    match /{path=**}/secrets/{id} {
      allow read: if true;
    }
  }
}`;

const UNPARSEABLE_RULES = `this is not a ruleset {{{`;

/** Stand up a sandbox with owner-gated rules and drive a DENIED write as bob
 *  (writing a doc owned by alice). Returns the captured event stream + the
 *  attempting auth so a re-run can reproduce it. */
function denyingSandbox() {
  const sandbox = initializeSandbox();
  getRulesFirestore(sandbox.withAuth(null)).setRules(OWNER_RULES);
  return sandbox;
}

describe('rules-debug model: Firestore denial → rule → context', () => {
  it('does not present a Studio admin LIST as a Rules evaluation', async () => {
    const sandbox = initializeSandbox();
    sandbox.admin.setDocument('posts/p1', { title: 'One' });
    const events: SandboxEvent[] = [];
    sandbox.onEvent((event) => events.push(event));
    const context = bindOperationContext(sandbox.withAuth(null), {
      source: { kind: 'studio' },
      authLens: { mode: 'admin' },
    });

    await getAdminFirestore(context).collection('posts').get();

    expect(selectRuleEvaluations(events)).toEqual([]);
    const list = events.find(
      (event) => event.kind === 'request' && event.method === 'list',
    );
    if (!list || list.kind !== 'request') throw new Error('Expected a Firestore LIST event');
    expect(list.rulesDisposition).toEqual({ kind: 'bypassed', reason: 'admin' });
  });

  it('projects a denied write into a Denial carrying rule, auth, and path/op', async () => {
    const sandbox = denyingSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    // Bob tries to write a note owned by alice → owner rule denies.
    const dbBob = getSandboxFirestore(sandbox.withAuth({ uid: 'bob' }));
    let threw = false;
    try {
      await setDoc(doc(dbBob, 'notes/n1'), { text: 'hi', owner: 'alice' });
    } catch (e) {
      threw = e instanceof Error
        && e.constructor.name === 'FirebaseError'
        && (e as { code?: unknown }).code === 'permission-denied';
    }
    expect(threw).toBe(true);

    const denials = selectDenials(events);
    expect(denials.length).toBeGreaterThanOrEqual(1);
    const d = denials[0];
    expect(d.service).toBe('firestore');
    expect(d.path).toBe('notes/n1');
    expect(['create', 'set', 'update']).toContain(d.method);
    expect(d.auth).toEqual({ uid: 'bob' });
    expect(d.resourceData).toEqual({ text: 'hi', owner: 'alice' });
    expect(d.reasons.length).toBeGreaterThan(0);

    const exp = explainDenial(d);
    expect(exp.engine).toBe('firestore');
    expect(exp.headline.length).toBeGreaterThan(0);
    // A genuine rule rejection is high severity.
    expect(denialSeverity(d)).toBe('high');
  });

  it('flags an implicit deny (no matching allow) distinctly', () => {
    // Hand-built denial with no matchedRule → implicit deny.
    const d: Denial = {
      result: 'deny',
      id: 'r1', at: Date.now(), method: 'get', path: 'secret/x',
      service: 'firestore',
      auth: { uid: 'bob' }, reasons: ['no allow rule matched'], origin: 'user', unsupported: false,
    };
    const exp = explainDenial(d);
    expect(exp.engine).toBe('firestore');
    expect(exp.implicitDeny).toBe(true);
    expect(exp.headline).toContain('implicit deny');
    expect(denialSeverity(d)).toBe('medium');
  });
});

describe('rules-debug model: RTDB denial → rule node → bindings', () => {
  it('explains a `.write` gate denial with the matched path and rule text', async () => {
    const sandbox = initializeSandbox();
    const adminDb = getDatabase(sandbox);
    rtdbSandbox.setRules(adminDb, {
      rules: {
        rooms: {
          '$roomId': {
            messages: {
              '$messageId': {
                '.write': "root.child('members').child($roomId).child(auth.uid).exists()",
              },
            },
          },
        },
      },
    });

    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const dbBob = getDatabase(sandbox.withAuth({ uid: 'bob' }));
    let threw = false;
    try {
      await set(ref(dbBob, '/rooms/r1/messages/m1'), { text: 'hi' });
    } catch (e) {
      threw = e instanceof Error && (e as Error & { code?: string }).code === 'PERMISSION_DENIED';
    }
    expect(threw).toBe(true);

    const denials = selectDenials(events);
    expect(denials.length).toBeGreaterThanOrEqual(1);
    const d = denials.find((x) => x.service === 'rtdb')!;
    expect(d).toBeDefined();
    expect(d.rules?.engine).toBe('rtdb');

    const exp = explainDenial(d);
    expect(exp.engine).toBe('rtdb');
    expect(exp.phase).toBe('write');
    expect(exp.implicitDeny).toBe(false);
    expect(exp.ruleNode).toContain('.write');
    expect(exp.ruleNode).toContain('/rooms/$roomId/messages/$messageId');
    expect(exp.ruleExpression).toContain('members');
    expect(exp.bindings).toEqual({ $roomId: 'r1', $messageId: 'm1' });
  });

  it('distinguishes a `.validate` rejection from a `.write` gate denial', async () => {
    const sandbox = initializeSandbox();
    const adminDb = getDatabase(sandbox);
    rtdbSandbox.setRules(adminDb, {
      rules: {
        counters: {
          '$id': {
            '.write': true,
            '.validate': 'newData.isNumber() && newData.val() > 0',
          },
        },
      },
    });

    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
    let threw = false;
    try {
      await set(ref(db, '/counters/c1'), -1);
    } catch (e) {
      threw = e instanceof Error && (e as Error & { code?: string }).code === 'PERMISSION_DENIED';
    }
    expect(threw).toBe(true);

    const denials = selectDenials(events);
    const d = denials.find((x) => x.service === 'rtdb')!;
    expect(d).toBeDefined();

    const exp = explainDenial(d);
    expect(exp.engine).toBe('rtdb');
    expect(exp.phase).toBe('validate');
    expect(exp.ruleNode).toContain('.validate');
    expect(exp.headline).toContain('.validate');
  });

  it('flags RTDB implicit deny (no matching rule) distinctly', () => {
    const d: Denial = {
      result: 'deny',
      id: 'r2', at: Date.now(), method: 'set', path: 'unmatched/x',
      service: 'rtdb',
      rules: { engine: 'rtdb', errorCode: 'NO_MATCHING_RULE' },
      auth: null, reasons: [], origin: 'user', unsupported: false,
    };
    const exp = explainDenial(d);
    expect(exp.engine).toBe('rtdb');
    expect(exp.implicitDeny).toBe(true);
    expect(exp.headline).toContain('RTDB implicit deny');
  });
});

describe('rules-debug: RTDB source line resolution (findRtdbRuleLine)', () => {
  const SAMPLE_RTDB_JSON = `{
  "rules": {
    "rooms": {
      "$roomId": {
        ".read": "auth != null",
        ".write": false
      }
    },
    "public": {
      ".read": true,
      ".write": false
    }
  }
}`;

  it('locates a unique rule expression and phase line number in database.rules.json', () => {
    const line = findRtdbRuleLine(SAMPLE_RTDB_JSON, 'read', 'auth != null', 'rooms/r1');
    expect(line).toBe(5);
  });

  it('disambiguates identical rules using preceding path segment context', () => {
    // Both rooms/$roomId and public have ".write": false on lines 6 and 11
    const lineRooms = findRtdbRuleLine(SAMPLE_RTDB_JSON, 'write', 'false', 'rooms/r1');
    expect(lineRooms).toBe(6);

    const linePublic = findRtdbRuleLine(SAMPLE_RTDB_JSON, 'write', 'false', 'public/data');
    expect(linePublic).toBe(11);
  });
});

describe('rules-debug explanation: Storage denials', () => {
  it('Storage: explains rule denial with match condition line', () => {
    const d: Denial = {
      result: 'deny',
      id: 's1', at: 0, method: 'write', path: 'sessions/x', service: 'storage',
      auth: { uid: 'bob' }, reasons: ['match /sessions/{id} write: condition false'],
      origin: 'user', unsupported: false,
    };

    const exp = explainDenial(d);
    expect(exp.engine).toBe('storage');
    expect(exp.implicitDeny).toBe(false);
    expect(exp.ruleNode).toBe('match /sessions/{id} write: condition false');
  });

  it('Storage: an implicit deny (no `match` line) is flagged distinctly', () => {
    const d: Denial = {
      result: 'deny',
      id: 's2', at: 0, method: 'write', path: 'unmatched/x', service: 'storage',
      auth: null, reasons: ['no rule matches write /unmatched/x'],
      origin: 'user', unsupported: false,
    };
    const exp = explainDenial(d);
    expect(exp.engine).toBe('storage');
    expect(exp.implicitDeny).toBe(true);
    expect(exp.headline).toContain('Storage implicit deny');
  });
});

describe('rules-debug re-run: edited ruleset (lint + fork + diff)', () => {
  it('the same denied op ALLOWS under permissive rules and reports the diff', async () => {
    const sandbox = denyingSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const dbBob = getSandboxFirestore(sandbox.withAuth({ uid: 'bob' }));
    try {
      await setDoc(doc(dbBob, 'notes/n1'), { text: 'hi', owner: 'alice' });
    } catch { /* expected deny */ }

    const denial = selectDenials(events)[0];
    const snapshot = sandbox.snapshot();

    const rerun = await rerunAgainstRules(snapshot, denial, PERMISSIVE_RULES, sandbox);
    expect(rerun.result.outcome).toBe('allow');
    expect(rerun.lint.parseable).toBe(true);
    // The write landed on the fork → a divergence vs the (empty) live snapshot.
    expect(rerun.diff.length).toBeGreaterThanOrEqual(1);
    expect(
      rerun.diff.some((dv) => dv.kind !== 'autoid-alias' && dv.path === 'notes/n1'),
    ).toBe(true);

    // Live sandbox is untouched: the branch was discarded, nothing promoted.
    expect(sandbox.admin.getDocument('notes/n1')).toBeNull();
  });

  it('re-running against the SAME (still-denying) rules denies again, empty diff', async () => {
    const sandbox = denyingSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const dbBob = getSandboxFirestore(sandbox.withAuth({ uid: 'bob' }));
    try {
      await setDoc(doc(dbBob, 'notes/n1'), { text: 'hi', owner: 'alice' });
    } catch { /* expected */ }

    const denial = selectDenials(events)[0];
    const rerun = await rerunAgainstRules(sandbox.snapshot(), denial, OWNER_RULES, sandbox);
    expect(rerun.result.outcome).toBe('deny');
    expect(rerun.diff.length).toBe(0);
  });

  it('blocks on an unparseable candidate ruleset (the only hard blocker)', async () => {
    const sandbox = denyingSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const dbBob = getSandboxFirestore(sandbox.withAuth({ uid: 'bob' }));
    try {
      await setDoc(doc(dbBob, 'notes/n1'), { text: 'hi', owner: 'alice' });
    } catch { /* expected */ }

    const denial = selectDenials(events)[0];
    const rerun = await rerunAgainstRules(sandbox.snapshot(), denial, UNPARSEABLE_RULES, sandbox);
    expect(rerun.result.outcome).toBe('error');
    if (rerun.result.outcome === 'error') expect(rerun.result.code).toBe('lint-parse-error');
    expect(rerun.lint.parseable).toBe(false);
    expect(rerun.diff.length).toBe(0);
  });

  it('surfaces a security-level lint finding but still runs the re-run (parses)', () => {
    const lint = lintEditedRuleset(RECURSIVE_OPEN_RULES);
    expect(lint.parseable).toBe(true);
    expect(lint.findings.some((f) => f.severity === 'error')).toBe(true);
  });
});

describe('rules-debug re-run: RTDB edited ruleset simulation', () => {
  it('re-running a denied RTDB write against permissive JSON rules ALLOWS', async () => {
    const sandbox = initializeSandbox();
    const adminDb = getDatabase(sandbox);
    rtdbSandbox.setRules(adminDb, {
      rules: {
        rooms: { '.write': false },
      },
    });
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const dbBob = getDatabase(sandbox.withAuth({ uid: 'bob' }));
    try {
      await set(ref(dbBob, '/rooms/r1/messages/m1'), { text: 'hi' });
    } catch { /* expected */ }
    const denials = selectDenials(events);
    const denial = denials.find((x) => x.service === 'rtdb')!;
    expect(denial).toBeDefined();

    const permissiveJson = JSON.stringify({ rules: { '.read': true, '.write': true } });
    const rerun = await rerunAgainstRules(sandbox.snapshot(), denial, permissiveJson, sandbox);
    expect(rerun.result.outcome).toBe('allow');
    expect(rerun.lint.parseable).toBe(true);
  });

  it('re-running against invalid RTDB rules JSON returns lint-parse-error', async () => {
    const sandbox = initializeSandbox();
    const d: Denial = {
      result: 'deny',
      id: 'r1', at: 0, method: 'set', path: 'rooms/r1', service: 'rtdb',
      rules: { engine: 'rtdb' },
      auth: { uid: 'bob' }, reasons: [], origin: 'user', unsupported: false,
    };
    const rerun = await rerunAgainstRules(sandbox.snapshot(), d, '{ invalid json', sandbox);
    expect(rerun.result.outcome).toBe('error');
    if (rerun.result.outcome === 'error') {
      expect(rerun.result.code).toBe('lint-parse-error');
    }
    expect(rerun.lint.parseable).toBe(false);
  });
});

describe('rules-debug re-run: as the attempting user (impersonation client)', () => {
  function fakeClient(deny: boolean): ImpersonationClient & { lensCalls: unknown[]; reissued: Denial[] } {
    const lensCalls: unknown[] = [];
    const reissued: Denial[] = [];
    return {
      lensCalls,
      reissued,
      setLens(lens) { lensCalls.push(lens); },
      async reissue(denial) {
        reissued.push(denial);
        if (deny) {
          const err = new Error('denied') as Error & { code: string };
          err.code = 'permission-denied';
          throw err;
        }
      },
    };
  }

  const denial: Denial = {
    result: 'deny',
    id: 'r1', at: 0, method: 'get', path: 'notes/n1',
    service: 'firestore',
    auth: { uid: 'alice' }, reasons: [], origin: 'user', unsupported: false,
  };

  it('sets {mode:as,uid}, re-issues, and restores the app-session lens (allow path)', async () => {
    const client = fakeClient(false);
    const res = await rerunAsUser(client, denial);
    expect(res.outcome).toBe('allow');
    expect(client.reissued).toEqual([denial]);
    expect(client.lensCalls[0]).toEqual({ mode: 'as', uid: 'alice' });
    expect(client.lensCalls.at(-1)).toEqual({ mode: 'app-session' });
  });

  it('reports deny when the impersonated re-issue is permission-denied', async () => {
    const client = fakeClient(true);
    const res = await rerunAsUser(client, denial);
    expect(res.outcome).toBe('deny');
    // Lens still restored even on the deny path.
    expect(client.lensCalls.at(-1)).toEqual({ mode: 'app-session' });
  });

  it('refuses an anonymous denial (no user to impersonate)', async () => {
    const client = fakeClient(false);
    const anon: Denial = { ...denial, auth: null };
    const res = await rerunAsUser(client, anon);
    expect(res.outcome).toBe('error');
    if (res.outcome === 'error') expect(res.code).toBe('no-user');
    // Never touched the lens: there was nothing to impersonate.
    expect(client.reissued.length).toBe(0);
  });
});

describe('rules-debug: line + expression trace threading (Firestore simulator)', () => {
  it('threads the denying rule line + sub-expression trace onto the Denial', async () => {
    const sandbox = denyingSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    const dbBob = getSandboxFirestore(sandbox.withAuth({ uid: 'bob' }));
    try {
      await setDoc(doc(dbBob, 'notes/n1'), { text: 'hi', owner: 'alice' });
    } catch { /* expected deny */ }

    const d = selectDenials(events)[0];
    // OWNER_RULES declares the denying `allow read, write` on source line 5.
    expect(d.evaluatedRule?.line).toBe(5);
    expect(Array.isArray(d.evaluatedRule?.expressionTrace)).toBe(true);
    expect(d.evaluatedRule!.expressionTrace!.length).toBeGreaterThan(0);
    // The condition text is carried too.
    expect(d.evaluatedRule?.expression).toContain('request.auth');
  });

  it('projects the trace into an evaluated step tree (pure, false branch marked)', async () => {
    const sandbox = denyingSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const dbBob = getSandboxFirestore(sandbox.withAuth({ uid: 'bob' }));
    try {
      await setDoc(doc(dbBob, 'notes/n1'), { text: 'hi', owner: 'alice' });
    } catch { /* expected */ }

    const d = selectDenials(events)[0];
    const steps = projectTraceSteps(d);
    expect(steps.length).toBeGreaterThan(0);
    // Every node carries an outcome classification; the whole condition (the
    // root) evaluated false (bob != alice), so at least one node is `false`.
    const flat: typeof steps = [];
    const walk = (s: (typeof steps)[number]) => { flat.push(s); s.children.forEach(walk); };
    steps.forEach(walk);
    expect(flat.some((s) => s.outcome === 'false')).toBe(true);
    // Depth is threaded so operands nest under their operator.
    expect(flat.some((s) => s.depth > 0)).toBe(true);
  });

  it('projectTraceSteps is empty for a denial with no trace (RTDB / implicit)', () => {
    const d: Denial = {
      result: 'deny',
      id: 'x', at: 0, method: 'get', path: 'a/b', service: 'firestore',
      auth: null, reasons: [], origin: 'user', unsupported: false,
    };
    expect(projectTraceSteps(d)).toEqual([]);
  });

  it('builds a nested tree from a synthetic flat trace', () => {
    const d: Denial = {
      result: 'deny',
      id: 'y', at: 0, method: 'get', path: 'a/b', service: 'firestore',
      auth: null, reasons: [], origin: 'user', unsupported: false,
      evaluatedRule: {
        verdict: 'deny',
        line: 3,
        expression: 'a && b',
        expressionTrace: [
          { source: 'a && b', kind: 'binary' as never, parent: null, value: false },
          { source: 'a', kind: 'identifier' as never, parent: 0, value: true },
          { source: 'b', kind: 'identifier' as never, parent: 0, value: false },
        ],
      },
    };
    const steps = projectTraceSteps(d);
    expect(steps.length).toBe(1);
    expect(steps[0].outcome).toBe('false');
    expect(steps[0].children.length).toBe(2);
    expect(steps[0].children[0].depth).toBe(1);
    expect(steps[0].children[1].outcome).toBe('false');
  });
});

describe('rules-debug: what the rule saw (ruleVariables)', () => {
  it('reports request.auth as absent-and-honest for an unauthenticated denial', () => {
    const d: Denial = {
      result: 'deny',
      id: 'z', at: 0, method: 'get', path: 'posts', service: 'firestore',
      auth: null, reasons: [], origin: 'user', unsupported: false,
    };
    const vars = ruleVariables(d);
    const auth = vars.find((v) => v.name === 'request.auth')!;
    expect(auth.present).toBe(false);
    expect(auth.absentNote).toContain('unauthenticated');
    // A read carries no proposed write — reported as honestly absent.
    const res = vars.find((v) => v.name === 'request.resource.data')!;
    expect(res.present).toBe(false);
  });

  it('surfaces the proposed write + existing resource when captured', () => {
    const d: Denial = {
      result: 'deny',
      id: 'w', at: 0, method: 'update', path: 'notes/n1', service: 'firestore',
      auth: { uid: 'bob' }, reasons: [], origin: 'user', unsupported: false,
      resourceData: { text: 'x' },
      resourceBefore: { data: { owner: 'alice' }, exists: true },
    };
    const vars = ruleVariables(d);
    expect(vars.find((v) => v.name === 'request.resource.data')!.present).toBe(true);
    expect(vars.find((v) => v.name === 'resource')!.present).toBe(true);
  });
});

describe('rules inspector: ALLOWED ops project + explain with the allowing rule', () => {
  it('selectRuleEvaluations includes allows; toDenial carries result + the allowing rule', async () => {
    const sandbox = denyingSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    // Alice writes her OWN note → the owner rule ALLOWS (line 5 of OWNER_RULES).
    const dbAlice = getSandboxFirestore(sandbox.withAuth({ uid: 'alice' }));
    await setDoc(doc(dbAlice, 'notes/a1'), { text: 'mine', owner: 'alice' });

    const all = selectRuleEvaluations(events);
    const allowed = all.find((d) => d.result === 'allow')!;
    expect(allowed).toBeDefined();
    expect(allowed.path).toBe('notes/a1');
    // The allowing rule's line + trace are threaded (evaluatedRule, verdict allow).
    expect(allowed.evaluatedRule?.verdict).toBe('allow');
    expect(allowed.evaluatedRule?.line).toBe(5);
    expect(allowed.evaluatedRule!.expressionTrace!.length).toBeGreaterThan(0);

    // But selectDenials still filters allows out.
    expect(selectDenials(events).some((d) => d.result === 'allow')).toBe(false);

    // The explanation names the allowing rule; not an implicit deny.
    const exp = explainDenial(allowed);
    expect(exp.headline).toContain('allowed');
    expect(exp.ruleNode).toContain('Rule #');
    expect(exp.implicitDeny).toBe(false);

    // Show-the-work projects for the allow too, with a passing root.
    const steps = projectTraceSteps(allowed);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].outcome).toBe('true');
  });

  it('allow severity is low (calm row, not a failure)', () => {
    const d: Denial = {
      result: 'allow',
      id: 'ok1', at: 0, method: 'get', path: 'posts/p1', service: 'firestore',
      auth: { uid: 'bob' }, reasons: [], origin: 'user', unsupported: false,
    };
    expect(denialSeverity(d)).toBe('low');
  });

  it('honesty guard: an "allow" with NO recorded evaluation says so (no undefined rule)', () => {
    // The owner-reported shape: result allow, but no matchedRule, no engine
    // verdict, no evaluatedRule, no per-rule trace lines — an admin bypass
    // from a worker that didn't stamp its lens.
    const d: Denial = {
      result: 'allow',
      id: 'ghost1', at: 0, method: 'get', path: 'conversations/alice-bob',
      service: 'firestore',
      auth: null, reasons: [], origin: 'user', unsupported: false,
    };
    const exp = explainDenial(d);
    expect(exp.noEvaluation).toBe(true);
    expect(exp.headline).toContain('no rules evaluation was recorded');
    // Never a claim it can't ground: no rule node, no "Rules allowed" line.
    expect(exp.ruleNode).toBeUndefined();
    expect(exp.headline).not.toContain('Rules allowed');
    // And no trace to show work with.
    expect(projectTraceSteps(d)).toEqual([]);
  });

  it('honesty guard does NOT fire for a genuine rules-allow (matched rule present)', () => {
    const d: Denial = {
      result: 'allow',
      id: 'real1', at: 0, method: 'create', path: 'posts/p1', service: 'firestore',
      auth: { uid: 'alice' },
      reasons: ['Rule #1 (create,write) → ALLOW', 'Simulated: ALLOW'],
      matchedRule: { ruleIndex: 1, operations: ['create', 'write'] },
      evaluatedRule: { verdict: 'allow', line: 6 },
      origin: 'user', unsupported: false,
    };
    const exp = explainDenial(d);
    expect(exp.noEvaluation).toBeUndefined();
    expect(exp.ruleNode).toBe('Rule #1 (create, write)');
    // The ✓ line marker's inputs are present: an allow verdict + a line.
    expect(d.evaluatedRule?.verdict).toBe('allow');
    expect(d.evaluatedRule?.line).toBe(6);
  });
});

describe('rules-debug: list/query denial re-run shape (INVALID-ARGUMENT fix)', () => {
  const LIST_DENY_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /locked/{id} { allow read, write: if false; }
  }
}`;

  async function listDenial() {
    const sandbox = initializeSandbox();
    getRulesFirestore(sandbox.withAuth(null)).setRules(LIST_DENY_RULES);
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));
    const db = getSandboxFirestore(sandbox.withAuth({ uid: 'bob' }));
    try {
      await getDocs(query(collection(db, 'locked')));
    } catch { /* expected deny */ }
    const d = selectDenials(events).find((x) => x.method === 'list')!;
    return { sandbox, denial: d };
  }

  it('reproduces a list denial as a COLLECTION read, never a raw doc-path error', async () => {
    const { sandbox, denial } = await listDenial();
    expect(denial).toBeDefined();
    expect(denial.method).toBe('list');
    expect(denial.path).toBe('locked'); // odd-segment collection path

    // Directly on the sandbox: the old code issued doc('locked') → INVALID-
    // ARGUMENT; the fix issues getDocs(collection('locked')), so a still-denying
    // ruleset returns a genuine DENY, not an SDK shape error.
    const res = await issueOp(sandbox, denial);
    expect(res.outcome).toBe('deny');
    if (res.outcome === 'deny') {
      expect(res.message).not.toContain('even number of segments');
    }
  });

  it('a list denial ALLOWS under permissive rules (no invalid-argument)', async () => {
    const { sandbox, denial } = await listDenial();
    const rerun = await rerunAgainstRules(sandbox.snapshot(), denial, PERMISSIVE_RULES, sandbox);
    expect(rerun.result.outcome).toBe('allow');
  });
});
