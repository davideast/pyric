/**
 * Rules-failure debugging: pure-logic tests (Pyric Studio F4).
 *
 * Drives the denial→rule→context model and the two re-run helpers against a REAL
 * pyric sandbox, with no browser/DOM. We:
 *   1. Deploy owner-gated rules, attempt a write that DENIES, and assert
 *      `selectDenials` / `explainDenial` project the rule, auth, and path/op the
 *      panel renders.
 *   2. RE-RUN AGAINST AN EDITED RULESET: `rerunAgainstRules` forks the snapshot
 *      with a permissive ruleset and shows the SAME op now ALLOWS, with a diff of
 *      what it wrote, while the live sandbox is untouched.
 *   3. RE-RUN AS THE ATTEMPTING USER: `rerunAsUser` over a fake impersonation
 *      client proves it sets `{ mode:'as', uid }`, re-issues, and restores the
 *      app-session lens, and rejects an anonymous denial (no user to be).
 */

import { describe, it, expect } from 'bun:test';
import {
  initializeSandbox,
  type SandboxEvent,
} from 'pyric/sandbox';
import { getFirestore as getAdminFirestore } from 'pyric/sandbox/admin-firestore';
import { getFirestore as getSandboxFirestore, doc, setDoc, SandboxError } from 'pyric/firestore';
import {
  selectDenials,
  explainDenial,
  denialSeverity,
  type Denial,
} from './model.js';
import {
  rerunAgainstRules,
  rerunAsUser,
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

/** Stand up a sandbox with owner-gated rules and drive a DENIED write as bob
 *  (writing a doc owned by alice). Returns the captured event stream + the
 *  attempting auth so a re-run can reproduce it. */
function denyingSandbox() {
  const sandbox = initializeSandbox();
  getAdminFirestore(sandbox.withAuth(null)).setRules(OWNER_RULES);
  return sandbox;
}

describe('rules-debug model: denial → rule → context', () => {
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
    expect(d.path).toBe('notes/n1');
    expect(['create', 'set', 'update']).toContain(d.method);
    expect(d.auth).toEqual({ uid: 'bob' });
    expect(d.resourceData).toEqual({ text: 'hi', owner: 'alice' });
    expect(d.reasons.length).toBeGreaterThan(0);

    const exp = explainDenial(d);
    expect(exp.headline.length).toBeGreaterThan(0);
    // A genuine rule rejection is high severity.
    expect(denialSeverity(d)).toBe('high');
  });

  it('flags an implicit deny (no matching allow) distinctly', () => {
    // Hand-built denial with no matchedRule → implicit deny.
    const d: Denial = {
      id: 'r1', at: Date.now(), method: 'get', path: 'secret/x',
      auth: { uid: 'bob' }, reasons: ['no allow rule matched'], origin: 'user', unsupported: false,
    };
    const exp = explainDenial(d);
    expect(exp.implicitDeny).toBe(true);
    expect(exp.headline).toContain('implicit deny');
    expect(denialSeverity(d)).toBe('medium');
  });
});

describe('rules-debug re-run: edited ruleset (fork + diff)', () => {
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
