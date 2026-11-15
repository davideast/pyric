import { describe, expect, it } from 'bun:test';
import { extractSdkUsage } from '../../src/assurance-surface/code/usage-index.js';
import { staticQueryProofPass } from '../../src/assurance-surface/passes/static-query-proof.js';

function runStaticQueryProof(rules: string, clientCode: string) {
  const usage = extractSdkUsage({
    root: '/app',
    files: {
      'src/query.ts': clientCode,
    },
  });
  return staticQueryProofPass(usage, rules);
}

const SIGNED_IN_LIST_ITEMS = `
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs, getFirestore } from 'firebase/firestore';

const auth = getAuth();
const db = getFirestore();
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  await getDocs(collection(db, 'items'));
});
`;

describe('staticQueryProofPass helper let-binding unseeded context detection', () => {
  it('does not emit static-proof errors when unseeded claims or lookups are bound in helper let statements', () => {
    const claimLetRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAdmin() {
      let role = request.auth.token.role;
      return role == 'admin';
    }
    match /items/{id} {
      allow list: if request.auth != null && isAdmin();
    }
  }
}`;
    expect(runStaticQueryProof(claimLetRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);

    const existsLetRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isMember() {
      let ok = exists(/databases/$(database)/documents/members/$(request.auth.uid));
      return ok;
    }
    match /items/{id} {
      allow list: if request.auth != null && isMember();
    }
  }
}`;
    expect(runStaticQueryProof(existsLetRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);

    const nestedExistsLetRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function hasFlag() {
      let ok = exists(/databases/$(database)/documents/config/public);
      return ok;
    }
    match /items/{id} {
      allow list: if hasFlag();
    }
  }
}`;
    expect(runStaticQueryProof(nestedExistsLetRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);
  });

  it('tracks request, auth, and token aliases across let bindings, helper returns, and parameters', () => {
    const tokenAliasRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAdmin() {
      let tok = request.auth.token;
      return tok.role == 'admin';
    }
    match /items/{id} {
      allow list: if request.auth != null && isAdmin();
    }
  }
}`;
    expect(runStaticQueryProof(tokenAliasRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);

    const chainedAliasRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAdmin() {
      let req = request;
      let auth = req.auth;
      let tok = auth.token;
      return tok.role == 'admin';
    }
    match /items/{id} {
      allow list: if request.auth != null && isAdmin();
    }
  }
}`;
    expect(runStaticQueryProof(chainedAliasRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);

    const helperReturnedTokenRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function authToken() {
      return request.auth.token;
    }
    function isAdmin() {
      let tok = authToken();
      return tok.role == 'admin';
    }
    match /items/{id} {
      allow list: if request.auth != null && isAdmin();
    }
  }
}`;
    expect(runStaticQueryProof(helperReturnedTokenRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);

    const paramAliasRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function hasRole(tok) {
      return tok.role == 'admin';
    }
    match /items/{id} {
      allow list: if request.auth != null && hasRole(request.auth.token);
    }
  }
}`;
    expect(runStaticQueryProof(paramAliasRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);

    const timeAliasRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isActiveWindow() {
      let req = request;
      return req.time > timestamp.date(2025, 1, 1);
    }
    match /items/{id} {
      allow list: if isActiveWindow();
    }
  }
}`;
    expect(runStaticQueryProof(timeAliasRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);
  });

  it('still emits static-proof errors when a helper with unseeded let also violates a concrete query constraint or returns false', () => {
    const limitRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function canList() {
      let role = request.auth.token.role;
      return role == 'admin' && request.query.limit <= 10;
    }
    match /items/{id} {
      allow list: if request.auth != null && canList();
    }
  }
}`;
    const overLimitCode = `
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs, getFirestore, limit, query } from 'firebase/firestore';

const auth = getAuth();
const db = getFirestore();
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  await getDocs(query(collection(db, 'items'), limit(50)));
});
`;
    const limitDiags = runStaticQueryProof(limitRules, overLimitCode);
    expect(limitDiags.length).toBe(1);
    expect(limitDiags[0]?.code).toBe('firestore-unprovable-list-query');
    expect(limitDiags[0]?.certainty).toBe('static-proof');

    const alwaysFalseRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function neverAllowed() {
      let role = request.auth.token.role;
      return false;
    }
    match /items/{id} {
      allow list: if request.auth != null && neverAllowed();
    }
  }
}`;
    const falseDiags = runStaticQueryProof(alwaysFalseRules, SIGNED_IN_LIST_ITEMS);
    expect(falseDiags.length).toBe(1);
    expect(falseDiags[0]?.code).toBe('firestore-unprovable-list-query');
    expect(falseDiags[0]?.certainty).toBe('static-proof');
  });

  it('flags int-only rules queried with integer equality filters as unprovable list queries', () => {
    const intOnlyRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if resource.data.score is int;
    }
  }
}`;
    const eqOneCode = `
import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';

const db = getFirestore();
export async function listScored() {
  return getDocs(query(collection(db, 'items'), where('score', '==', 1)));
}
`;
    const diagsOne = runStaticQueryProof(intOnlyRules, eqOneCode);
    expect(diagsOne.length).toBe(1);
    expect(diagsOne[0]?.code).toBe('firestore-unprovable-list-query');

    const missesPositiveZeroRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if resource.data.score is int || string(resource.data.score) == '-0.0';
    }
  }
}`;
    const eqZeroCode = `
import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';

const db = getFirestore();
export async function listZeroScored() {
  return getDocs(query(collection(db, 'items'), where('score', '==', 0)));
}
`;
    const diagsZero = runStaticQueryProof(missesPositiveZeroRules, eqZeroCode);
    expect(diagsZero.length).toBe(1);
    expect(diagsZero[0]?.code).toBe('firestore-unprovable-list-query');
  });

  it('preserves lexical scoping when a caller param or let shadows a match wildcard read by a callee', () => {
    const dynamicOrgList = `
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs, getFirestore } from 'firebase/firestore';

const auth = getAuth();
const db = getFirestore();
export function listOrgItems(orgId: string) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    await getDocs(collection(db, 'orgs', orgId, 'items'));
  });
}
`;

    const paramShadowCalleeRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/items/{id} {
      function getOrg() {
        return orgId;
      }
      function wrapper(orgId) {
        return getOrg();
      }
      allow list: if request.auth != null && request.auth.token.admin == true && wrapper('x') == 'acme';
    }
  }
}`;
    expect(runStaticQueryProof(paramShadowCalleeRules, dynamicOrgList)).toEqual([]);

    const letShadowCalleeRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/items/{id} {
      function getOrg() {
        return orgId;
      }
      function wrapper() {
        let orgId = 'other';
        return getOrg();
      }
      allow list: if request.auth != null && request.auth.token.admin == true && wrapper() == 'acme';
    }
  }
}`;
    expect(runStaticQueryProof(letShadowCalleeRules, dynamicOrgList)).toEqual([]);

    const ownParamShadowControlRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/items/{id} {
      function wrapper(orgId) {
        return orgId == 'acme';
      }
      allow list: if request.auth != null && request.auth.token.admin == true && wrapper('other');
    }
  }
}`;
    const controlDiags = runStaticQueryProof(ownParamShadowControlRules, dynamicOrgList);
    expect(controlDiags.length).toBe(1);
    expect(controlDiags[0]?.code).toBe('firestore-unprovable-list-query');
    expect(controlDiags[0]?.certainty).toBe('static-proof');
  });

  it('tracks member, bracket, method, and in projections over helper calls returning auth or token', () => {
    const authMemberLetRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function getAuth() {
      return request.auth;
    }
    function isAdmin() {
      let tok = getAuth().token;
      return tok.role == 'admin';
    }
    match /items/{id} {
      allow list: if request.auth != null && isAdmin();
    }
  }
}`;
    expect(runStaticQueryProof(authMemberLetRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);

    const tokenClaimLetRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function getToken() {
      return request.auth.token;
    }
    function isAdmin() {
      let role = getToken().role;
      return role == 'admin';
    }
    match /items/{id} {
      allow list: if request.auth != null && isAdmin();
    }
  }
}`;
    expect(runStaticQueryProof(tokenClaimLetRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);

    const chainedAuthTokenClaimLetRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function getAuth() {
      return request.auth;
    }
    function isAdmin() {
      let role = getAuth().token.role;
      return role == 'admin';
    }
    match /items/{id} {
      allow list: if request.auth != null && isAdmin();
    }
  }
}`;
    expect(runStaticQueryProof(chainedAuthTokenClaimLetRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);

    const bracketAndMethodRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function getToken() {
      return request.auth.token;
    }
    function isAdmin() {
      let role = getToken()['role'];
      return role == 'admin' || ('tier' in getToken() && getToken().get('tier', '') == 'pro');
    }
    match /items/{id} {
      allow list: if request.auth != null && isAdmin();
    }
  }
}`;
    expect(runStaticQueryProof(bracketAndMethodRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);

    const inlineHelperProjectionRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function getAuth() {
      return request.auth;
    }
    match /items/{id} {
      allow list: if request.auth != null && getAuth().token.role == 'admin';
    }
  }
}`;
    expect(runStaticQueryProof(inlineHelperProjectionRules, SIGNED_IN_LIST_ITEMS)).toEqual([]);

    const dischargedUidWithFalseControlRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function getAuth() {
      return request.auth;
    }
    match /items/{id} {
      allow list: if request.auth != null && getAuth().uid == resource.data.ownerId && false;
    }
  }
}`;
    const ownerList = `
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';

const auth = getAuth();
const db = getFirestore();
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  await getDocs(query(collection(db, 'items'), where('ownerId', '==', user.uid)));
});
`;
    const controlDiags = runStaticQueryProof(dischargedUidWithFalseControlRules, ownerList);
    expect(controlDiags.length).toBe(1);
    expect(controlDiags[0]?.code).toBe('firestore-unprovable-list-query');
    expect(controlDiags[0]?.certainty).toBe('static-proof');
  });
});
