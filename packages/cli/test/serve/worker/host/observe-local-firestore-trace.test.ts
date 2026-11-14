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
});
