import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { createObservedSessionDataStore } from '../../../../src/serve/observed-session/store.js';
import type { HostCtx } from '../../../../src/serve/worker/host.js';
import { firestoreVerdict } from '../../../../src/serve/worker/host/observe-local-firestore.js';
import { deployFirestoreRulesToHost } from '../../../../src/serve/worker/host/rules.js';

const DENIED = { status: 'error', code: 'permission-denied' } as const;

function makeHost(): HostCtx {
  const sandbox = initializeSandbox();
  const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'fs-trace-canon-test',
    subs: new Map(),
    rtdbProjectId: 'demo-project',
    observedSession,
  };
}

describe('observe-local-firestore structural trace canonicalization', () => {
  it('abstains on arbitrarily parenthesized helper calls, existsAfter/getAfter, and member/method chains', () => {
    const ctx = makeHost();
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function allowWhenGuest(req) {
      return req.auth != null && ((req.auth).token).get(('role'), 'guest') == 'guest';
    }
    match /items/{id} {
      allow get: if ((allowWhenGuest((request))));
      allow create: if !(((existsAfter(/databases/$(database)/documents/orgs/org-1))));
      allow delete: if (((getAfter(/databases/$(database)/documents/orgs/org-1))).data.open == false);
    }
  }
}`,
      ).ok,
    ).toBe(true);

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDoc',
          path: 'items/item-1',
          at: 100,
          outcome: DENIED,
          account: { uid: 'u-1', claimNames: ['role', 'sub'] },
        },
        'get',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'setDoc',
          path: 'items/item-new',
          at: 101,
          outcome: DENIED,
          account: { uid: 'u-1', claimNames: ['sub'], claims: { sub: 'u-1' } },
          writeData: { label: 'alpha' },
        },
        'create',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['stored-document'] });
  });

  it('abstains when request.auth.token or request.auth.token.firebase is wrapped in map/list literals, ternaries, or let bindings', () => {
    const ctx = makeHost();
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function checkBoxedRole(box) {
      let tok = box.tok;
      return tok.get('role', 'guest') == 'guest';
    }
    match /docs/{docId} {
      allow get: if request.auth != null && {'tok': request.auth.token}.tok.get('email', '') == '';
      allow create: if request.auth != null && [request.auth.token][0].get('email', '') == '';
      allow update: if request.auth != null && request.auth.token.firebase == {'sign_in_provider': 'password'};
      allow delete: if request.auth != null && checkBoxedRole({'tok': (request.auth.uid == 'u-1' ? request.auth.token : {})});
    }
  }
}`,
      ).ok,
    ).toBe(true);

    // Email is in claimNames but omitted from claims (`!emailKnown`).
    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDoc',
          path: 'docs/doc-map',
          at: 200,
          outcome: DENIED,
          account: { uid: 'u-1', claimNames: ['email', 'sub'], claims: { sub: 'u-1' } },
        },
        'get',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'setDoc',
          path: 'docs/doc-list',
          at: 201,
          outcome: DENIED,
          account: { uid: 'u-1', claimNames: ['email', 'sub'], claims: { sub: 'u-1' } },
          writeData: { title: 'a' },
        },
        'create',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'updateDoc',
          path: 'docs/doc-firebase',
          at: 202,
          outcome: DENIED,
          account: {
            uid: 'u-1',
            claimNames: ['email', 'sub', 'firebase'],
            claims: { sub: 'u-1', firebase: { sign_in_provider: 'password' } },
          },
          writeData: { title: 'b' },
        },
        'update',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'deleteDoc',
          path: 'docs/doc-boxed',
          at: 203,
          outcome: DENIED,
          account: { uid: 'u-1', claimNames: ['role', 'sub'] },
        },
        'delete',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });
  });

  it('preserves helper scopes across duplicate root and child match blocks instead of overwriting earlier helpers', () => {
    const ctx = makeHost();
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function checkAccess(req) {
      return req.auth != null && req.auth.token.get('role', 'guest') == 'guest';
    }
    match /items/{id} {
      function checkLocal(req) {
        return req.auth.token.get('tier', 'free') == 'free';
      }
      allow get: if checkAccess(request);
      allow delete: if checkLocal(request);
    }
    match /items/{id} {
      function checkLocal(r) {
        return r.auth != null;
      }
      allow create: if false;
    }
  }
  match /databases/{database}/documents {
    function checkAccess(r) {
      return r.auth != null;
    }
    match /items/{id} {
      allow create: if false;
    }
    match /notes/{id} {
      allow get: if checkAccess(request);
    }
  }
}`,
      ).ok,
    ).toBe(true);

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDoc',
          path: 'items/item-dup-root',
          at: 300,
          outcome: DENIED,
          account: { uid: 'u-1', claimNames: ['role', 'sub'] },
        },
        'get',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'deleteDoc',
          path: 'items/item-dup-child',
          at: 301,
          outcome: DENIED,
          account: { uid: 'u-1', claimNames: ['tier', 'sub'] },
        },
        'delete',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });
  });

  it('abstains across list slices, concat/removeAll, map.values, in membership, and set/list membership on email containers', () => {
    const ctx = makeHost();
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /slices/{id} {
      allow get: if ['pad', request][1:2][0].auth.token.get('role', 'guest') == 'guest';
      allow create: if ['pad', request.auth.token][1:2][0].get('email', '') == '';
      allow update: if (request.auth.uid == 'u-1' ? ['pad', request.auth.token] : ['pad', request.auth.token])[1:2][0].get('email', '') == '';
      allow delete: if request.auth.token.firebase in [{'sign_in_provider': 'password', 'identities': {}}];
    }
    match /containers/{id} {
      allow get: if ([request].concat([]))[0].auth.token.get('role', 'guest') == 'guest';
      allow create: if ([request].removeAll([]))[0].auth.token.get('role', 'guest') == 'guest';
      allow update: if {'req': request}.values()[0].auth.token.get('role', 'guest') == 'guest';
      allow delete: if [request.auth.token.firebase].hasAny([{'sign_in_provider': 'password', 'identities': {}}])
                    || [request.auth.token.firebase, {'sign_in_provider': 'password', 'identities': {}}].toSet().size() == 1;
    }
  }
}`,
      ).ok,
    ).toBe(true);

    const missingClaimsAccount = { uid: 'u-1', claimNames: ['role', 'sub'] };
    const missingEmailAccount = {
      uid: 'u-1',
      claimNames: ['email', 'firebase', 'sub'],
      claims: { sub: 'u-1', firebase: { sign_in_provider: 'password', identities: {} } },
    };

    expect(
      firestoreVerdict(
        ctx,
        { service: 'firestore', method: 'getDoc', path: 'slices/s-1', at: 400, outcome: DENIED, account: missingClaimsAccount },
        'get',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        { service: 'firestore', method: 'setDoc', path: 'slices/s-2', at: 401, outcome: DENIED, account: missingEmailAccount, writeData: { ok: true } },
        'create',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        { service: 'firestore', method: 'updateDoc', path: 'slices/s-3', at: 402, outcome: DENIED, account: missingEmailAccount, writeData: { ok: true } },
        'update',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        { service: 'firestore', method: 'deleteDoc', path: 'slices/s-4', at: 403, outcome: DENIED, account: missingEmailAccount },
        'delete',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        { service: 'firestore', method: 'getDoc', path: 'containers/c-1', at: 404, outcome: DENIED, account: missingClaimsAccount },
        'get',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        { service: 'firestore', method: 'setDoc', path: 'containers/c-2', at: 405, outcome: DENIED, account: missingClaimsAccount, writeData: { ok: true } },
        'create',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        { service: 'firestore', method: 'updateDoc', path: 'containers/c-3', at: 406, outcome: DENIED, account: missingClaimsAccount, writeData: { ok: true } },
        'update',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        { service: 'firestore', method: 'deleteDoc', path: 'containers/c-4', at: 407, outcome: DENIED, account: missingEmailAccount },
        'delete',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });
  });
});
