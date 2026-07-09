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
import { getFirestore as getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { getFirestore as getSandboxFirestore, doc, setDoc, SandboxError } from 'pyric/firestore';
import { getDatabase, ref, set, sandbox as rtdbSandbox } from 'pyric/database';
import {
  selectDenials,
  explainDenial,
  denialSeverity,
  rerunSupport,
  type Denial,
} from './model.js';
import {
  rerunAgainstRules,
  rerunAsUser,
  lintEditedRuleset,
  type ImpersonationClient,
} from './rerun.js';

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
  getAdminFirestore(sandbox.withAuth(null)).setRules(OWNER_RULES);
  return sandbox;
}

describe('rules-debug model: Firestore denial → rule → context', () => {
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
      threw = e instanceof SandboxError && e.code === 'permission-denied';
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

describe('rules-debug re-run: capability grading per service (rerunSupport)', () => {
  it('Firestore: both re-run paths are live', () => {
    const d: Denial = {
      id: 'f1', at: 0, method: 'get', path: 'notes/n1', service: 'firestore',
      auth: { uid: 'bob' }, reasons: [], origin: 'user', unsupported: false,
    };
    const support = rerunSupport(d);
    expect(support.impersonate.kind).toBe('live');
    expect(support.editedRuleset.kind).toBe('live');
  });

  it('RTDB: both re-run paths are pending, naming rtdb_simulate_access', () => {
    const d: Denial = {
      id: 'r1', at: 0, method: 'set', path: 'rooms/r1', service: 'rtdb',
      rules: { engine: 'rtdb' },
      auth: { uid: 'bob' }, reasons: [], origin: 'user', unsupported: false,
    };
    const support = rerunSupport(d);
    expect(support.impersonate.kind).toBe('pending');
    expect(support.editedRuleset.kind).toBe('pending');
    if (support.impersonate.kind === 'pending') {
      expect(support.impersonate.tool).toBe('rtdb_simulate_access');
    }
  });

  it('Storage: both re-run paths are absent, naming storage_simulate_rules', () => {
    const d: Denial = {
      id: 's1', at: 0, method: 'write', path: 'sessions/x', service: 'storage',
      auth: { uid: 'bob' }, reasons: ['match /sessions/{id} write: condition false'],
      origin: 'user', unsupported: false,
    };
    const support = rerunSupport(d);
    expect(support.impersonate.kind).toBe('absent');
    expect(support.editedRuleset.kind).toBe('absent');
    if (support.impersonate.kind === 'absent') {
      expect(support.impersonate.missingTool).toBe('storage_simulate_rules');
    }
    if (support.editedRuleset.kind === 'absent') {
      expect(support.editedRuleset.missingTool).toContain('storage_simulate_rules');
    }

    const exp = explainDenial(d);
    expect(exp.engine).toBe('storage');
    expect(exp.implicitDeny).toBe(false);
    expect(exp.ruleNode).toBe('match /sessions/{id} write: condition false');
  });

  it('Storage: an implicit deny (no `match` line) is flagged distinctly', () => {
    const d: Denial = {
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
