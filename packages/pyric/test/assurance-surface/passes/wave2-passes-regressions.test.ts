import { describe, expect, it } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { projectRuleSurface } from '../../../src/assurance-surface/rules/rule-surface.js';
import { coverageMatrixPass } from '../../../src/assurance-surface/passes/coverage-matrix.js';
import { rtdbIndexPass } from '../../../src/assurance-surface/passes/rtdb-indexes.js';
import { checkRtdbIndexes } from '../../../src/assurance-surface/passes/rtdb-rules-check.js';
import { mergeRtdbIndexes } from '../../../src/assurance-surface/passes/rtdb-rules-merge.js';
import { expandQueryArmsWithTruncation } from '../../../src/assurance-surface/passes/static-query-proof-args.js';
import { staticQueryProofPass } from '../../../src/assurance-surface/passes/static-query-proof.js';
import { storageContractPass } from '../../../src/assurance-surface/passes/storage-contract.js';
import type { SandboxSnapshot } from '../../../src/sandbox/internal/snapshot-codec.js';

describe('static assurance passes regressions', () => {
  it('unifies auth.uid in where(...) with literal parent document IDs on subcollection queries', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/items/{id} {
      allow read: if request.auth != null
        && request.auth.uid == uid
        && resource.data.editorId == request.auth.uid;
    }
    match /orgs/{orgId}/docs/{docId} {
      allow read: if request.auth != null
        && request.auth.uid == orgId
        && resource.data.ownerUid == orgId;
    }
  }
}`;

    const validUsage = extractSdkUsage({
      root: '/app',
      files: {
        'src/list.ts': `
          import { getAuth } from 'firebase/auth';
          import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';
          export async function run() {
            const uid = getAuth().currentUser!.uid;
            const db = getFirestore();
            await getDocs(query(collection(db, 'users/u1/items'), where('editorId', '==', uid)));
            await getDocs(query(collection(db, 'orgs/o1/docs'), where('ownerUid', '==', uid)));
          }
        `,
      },
    });
    expect(staticQueryProofPass(validUsage, rules)).toEqual([]);

    const invalidUsage = extractSdkUsage({
      root: '/app',
      files: {
        'src/unfiltered.ts': `
          import { collection, getDocs, getFirestore, query } from 'firebase/firestore';
          export async function run() {
            await getDocs(query(collection(getFirestore(), 'users/u1/items')));
          }
        `,
      },
    });
    const diags = staticQueryProofPass(invalidUsage, rules);
    expect(diags.length).toBe(1);
    expect(diags[0]?.certainty).toBe('static-proof');
  });

  it('handles custom token claims in where(...) paired with concrete claim guards in rules', () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if request.auth != null
        && request.auth.token.role == 'admin'
        && resource.data.role == request.auth.token.role;
    }
    match /docs/{docId} {
      allow read: if request.auth != null
        && request.auth.token.scope.matches('^team_.*')
        && resource.data.scope == request.auth.token.scope;
    }
    match /denied/{id} {
      allow read: if false && resource.data.role == request.auth.token.role;
    }
  }
}`;

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/claims.ts': `
          import { getAuth, getIdTokenResult } from 'firebase/auth';
          import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';
          export async function run() {
            const tokenResult = await getIdTokenResult(getAuth().currentUser!);
            const db = getFirestore();
            await getDocs(query(collection(db, 'items'), where('role', '==', tokenResult.claims.role)));
            await getDocs(query(collection(db, 'docs'), where('scope', '==', tokenResult.claims.scope)));
            await getDocs(query(collection(db, 'denied'), where('role', '==', tokenResult.claims.role)));
          }
        `,
      },
    });

    const diags = staticQueryProofPass(usage, rules);
    expect(diags.length).toBe(1);
    expect(diags[0]?.message).toContain("'denied'");
    expect(diags[0]?.certainty).toBe('static-proof');
  });

  it('normalizes and projects all top-level service cloud.firestore match blocks', () => {
    const multiDbRules = `rules_version = '2';
service cloud.firestore {
  match /databases/primary/documents {
    match /docs/{docId} {
      allow read: if false;
    }
  }
  match /databases/secondary/documents {
    match /items/{id} {
      allow read: if true;
    }
  }
}`;
    const namedDbUsage = extractSdkUsage({
      root: '/app',
      files: {
        'src/secondary.ts': `
          import { initializeApp } from 'firebase/app';
          import { collection, getDocs, getFirestore, query } from 'firebase/firestore';
          const app = initializeApp({ projectId: 'app-1' });
          const db = getFirestore(app, 'secondary');
          export async function load() {
            return getDocs(query(collection(db, 'items')));
          }
        `,
      },
    });
    expect(
      staticQueryProofPass(namedDbUsage, {
        rules: { secondary: multiDbRules },
        rulesFile: { secondary: 'secondary.rules' },
      }),
    ).toEqual([]);

    const cgDenyRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{path=**}/items/{id} {
      allow read: if false;
    }
  }
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if true;
    }
  }
}`;
    const cgDenyUsage = extractSdkUsage({
      root: '/app',
      files: {
        'src/cg-deny.ts': `
          import { collectionGroup, getDocs, getFirestore, query } from 'firebase/firestore';
          export async function load() {
            return getDocs(query(collectionGroup(getFirestore(), 'items')));
          }
        `,
      },
    });
    const cgDenyDiags = staticQueryProofPass(cgDenyUsage, cgDenyRules);
    expect(cgDenyDiags.length).toBe(1);
    expect(cgDenyDiags[0]?.certainty).toBe('static-proof');

    const cgAllowRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function canRead() {
      return false;
    }
    match /docs/{docId} {
      allow read: if canRead();
    }
  }
  match /databases/{database}/documents {
    function canRead() {
      return request.auth != null;
    }
    match /{path=**}/items/{id} {
      allow read: if canRead() && resource.data.ownerId == request.auth.uid;
    }
  }
}`;
    const cgAllowUsage = extractSdkUsage({
      root: '/app',
      files: {
        'src/cg-allow.ts': `
          import { getAuth } from 'firebase/auth';
          import { collectionGroup, getDocs, getFirestore, query, where } from 'firebase/firestore';
          export async function load() {
            const uid = getAuth().currentUser!.uid;
            return getDocs(query(collectionGroup(getFirestore(), 'items'), where('ownerId', '==', uid)));
          }
        `,
      },
    });
    expect(staticQueryProofPass(cgAllowUsage, cgAllowRules)).toEqual([]);
  });

  it('evaluates all 64 conditional query branches and downgrades truncated DNF expansions', () => {
    const ownerRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if request.auth != null && resource.data.ownerId == request.auth.uid;
    }
  }
}`;

    const branchedBroken = extractSdkUsage({
      root: '/app',
      files: {
        'src/branched-bad.ts': `
          import { getAuth } from 'firebase/auth';
          import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';
          export async function load(
            f0: boolean,
            f1: boolean,
            f2: boolean,
            f3: boolean,
            f4: boolean,
            f5: boolean,
          ) {
            const uid = getAuth().currentUser!.uid;
            return getDocs(
              query(
                collection(getFirestore(), 'items'),
                f0 ? where('ownerId', '==', uid) : where('s0', '==', 'pub'),
                f1 ? where('t1', '==', 1) : where('t1', '==', 2),
                f2 ? where('t2', '==', 1) : where('t2', '==', 2),
                f3 ? where('t3', '==', 1) : where('t3', '==', 2),
                f4 ? where('t4', '==', 1) : where('t4', '==', 2),
                f5 ? where('t5', '==', 1) : where('t5', '==', 2),
              ),
            );
          }
        `,
      },
    });
    const brokenDiags = staticQueryProofPass(branchedBroken, ownerRules);
    expect(brokenDiags.length).toBe(1);
    expect(brokenDiags[0]?.certainty).toBe('static-proof');

    const branchedSafe = extractSdkUsage({
      root: '/app',
      files: {
        'src/branched-ok.ts': `
          import { getAuth } from 'firebase/auth';
          import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';
          export async function load(
            f0: boolean,
            f1: boolean,
            f2: boolean,
            f3: boolean,
            f4: boolean,
            f5: boolean,
          ) {
            const uid = getAuth().currentUser!.uid;
            return getDocs(
              query(
                collection(getFirestore(), 'items'),
                f0 ? where('ownerId', '==', uid) : where('ownerId', '==', uid),
                f1 ? where('t1', '==', 1) : where('t1', '==', 2),
                f2 ? where('t2', '==', 1) : where('t2', '==', 2),
                f3 ? where('t3', '==', 1) : where('t3', '==', 2),
                f4 ? where('t4', '==', 1) : where('t4', '==', 2),
                f5 ? where('t5', '==', 1) : where('t5', '==', 2),
              ),
            );
          }
        `,
      },
    });
    expect(staticQueryProofPass(branchedSafe, ownerRules)).toEqual([]);

    const hugeDnfUsage = extractSdkUsage({
      root: '/app',
      files: {
        'src/huge-dnf.ts': `
          import { getAuth } from 'firebase/auth';
          import { and, collection, getDocs, getFirestore, or, query, where } from 'firebase/firestore';
          export async function load() {
            const uid = getAuth().currentUser!.uid;
            return getDocs(
              query(
                collection(getFirestore(), 'items'),
                and(
                  where('ownerId', '==', uid),
                  or(where('a', '==', 1), where('a', '==', 2), where('a', '==', 3), where('a', '==', 4)),
                  or(where('b', '==', 1), where('b', '==', 2), where('b', '==', 3), where('b', '==', 4)),
                  or(where('c', '==', 1), where('c', '==', 2), where('c', '==', 3), where('c', '==', 4)),
                  or(where('d', '==', 1), where('d', '==', 2)),
                ),
              ),
            );
          }
        `,
      },
    });
    const expanded = expandQueryArmsWithTruncation(hugeDnfUsage.queries[0]!);
    expect(expanded.truncated).toBe(true);
    const truncatedDiags = staticQueryProofPass(hugeDnfUsage, ownerRules);
    expect(truncatedDiags.length).toBe(1);
    expect(truncatedDiags[0]?.certainty).toBe('heuristic');
  });

  it('OR-combines wildcard match /b/{bucket}/o and concrete match /b/<bucket>/o rules while keeping separate target files isolated', () => {
    const combinedRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow read, write: if request.resource == null || request.resource.contentType.matches('image/.*');
    }
    match /items/{id} {
      allow write: if request.resource.contentType.matches('image/.*');
    }
  }
  match /b/items-bucket/o {
    match /items/{id} {
      allow write: if request.resource.contentType.matches('application/pdf');
    }
  }
}`;
    const surface = projectRuleSurface({ storage: combinedRules });

    const validUsage = extractSdkUsage({
      root: '/app',
      files: {
        'src/valid.ts': `
          import { initializeApp } from 'firebase/app';
          import { getStorage, ref, uploadBytes } from 'firebase/storage';
          const app = initializeApp({ projectId: 'app-1' });
          const st = getStorage(app, 'gs://items-bucket');
          export async function run() {
            await uploadBytes(ref(st, 'docs/d1'), new Uint8Array(4), { contentType: 'image/png' });
            await uploadBytes(ref(st, 'items/i1'), new Uint8Array(4), { contentType: 'image/png' });
          }
        `,
      },
    });
    expect(coverageMatrixPass(validUsage, surface)).toEqual([]);
    expect(storageContractPass(validUsage, { ruleSurface: surface })).toEqual([]);

    const invalidUsage = extractSdkUsage({
      root: '/app',
      files: {
        'src/invalid.ts': `
          import { initializeApp } from 'firebase/app';
          import { getStorage, ref, uploadBytes } from 'firebase/storage';
          const app = initializeApp({ projectId: 'app-1' });
          const st = getStorage(app, 'gs://items-bucket');
          export async function run() {
            await uploadBytes(ref(st, 'docs/d2'), new Uint8Array(4), { contentType: 'text/plain' });
          }
        `,
      },
    });
    const invalidContract = storageContractPass(invalidUsage, { ruleSurface: surface });
    expect(invalidContract.map((d) => d.code)).toEqual(['storage-content-type-mismatch']);

    const multiTargetSurface = projectRuleSurface({
      storage: [
        {
          source: 'default.storage.rules',
          text: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow read, write: if true;
    }
  }
}`,
        },
        {
          source: 'docs.storage.rules',
          bucket: 'docs-bucket',
          text: `rules_version = '2';
service firebase.storage {
  match /b/docs-bucket/o {
    match /items/{id} {
      allow write: if true;
      allow read: if false;
    }
  }
}`,
        },
      ],
    });
    const multiTargetUsage = extractSdkUsage({
      root: '/app',
      files: {
        'src/read-docs.ts': `
          import { initializeApp } from 'firebase/app';
          import { getBytes, getStorage, ref } from 'firebase/storage';
          const app = initializeApp({ projectId: 'app-1' });
          export async function run() {
            await getBytes(ref(getStorage(app, 'gs://docs-bucket'), 'items/i1'));
          }
        `,
      },
    });
    const multiTargetCoverage = coverageMatrixPass(multiTargetUsage, multiTargetSurface);
    expect(
      multiTargetCoverage.some(
        (d) => d.code === 'uncovered-client-operation' && d.resourceId === 'docs-bucket',
      ),
    ).toBe(true);
  });

  it('scopes size and customMetadata witnesses to MIME-compatible sibling Storage rules', () => {
    const splitRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId} {
      allow write: if request.resource.contentType.matches('image/png')
        && request.resource.size <= 100
        && request.resource.metadata.ownerId != null
        && request.resource.metadata.tag != null;
      allow write: if request.resource.contentType.matches('application/pdf')
        && request.resource.size <= 10000
        && request.resource.metadata.docId != null;
    }
  }
}`;
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/upload.ts': `
          import { getStorage, ref, uploadBytes } from 'firebase/storage';
          export async function run() {
            await uploadBytes(ref(getStorage(), 'docs/d1'), new Uint8Array(20000), {
              contentType: 'image/png',
              customMetadata: {},
            });
          }
        `,
      },
    });
    const diags = storageContractPass(usage, splitRules);
    const sizeDiag = diags.find((d) => d.code === 'storage-max-size-exceeded');
    const metaDiag = diags.find((d) => d.code === 'storage-missing-custom-metadata');
    expect(sizeDiag?.witness?.[0]).toEqual({ sizeBytes: 20000, maxSizeBytes: 100 });
    expect(metaDiag?.witness?.[0]).toEqual({ missingKeys: ['ownerId', 'tag'] });
  });

  it('never leaks unbound client identifiers and preserves composite segment affixes in overbroad-auth-only-write remediation', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/owner-writes.ts': `
          import { getAuth } from 'firebase/auth';
          import { doc, getFirestore, setDoc } from 'firebase/firestore';
          import { getDatabase, ref as dbRef, set } from 'firebase/database';
          import { getStorage, ref as stRef, uploadBytes } from 'firebase/storage';
          export async function run(docId: string, tabId: string) {
            const callerUid = getAuth().currentUser!.uid;
            await uploadBytes(
              stRef(getStorage(), \`docs/\${docId}/users/\${callerUid}/items/i1\`),
              new Uint8Array(4),
            );
            await setDoc(doc(getFirestore(), \`items/user_\${callerUid}\`), { tag: 'x' });
            await setDoc(doc(getFirestore(), \`sessions/\${callerUid}:\${tabId}\`), { active: true });
            await set(dbRef(getDatabase(), \`users/\${callerUid}/items/i1\`), { rank: 1 });
            await set(dbRef(getDatabase(), \`entries/user_\${callerUid}\`), { rank: 1 });
          }
        `,
      },
    });

    const surface = projectRuleSurface({
      storage: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /docs/{docId}/{allPaths=**} {
      allow write: if request.auth != null;
    }
  }
}`,
      firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow write: if request.auth != null;
    }
    match /sessions/{sessionKey} {
      allow write: if request.auth != null;
    }
  }
}`,
      rtdb: {
        rules: {
          users: {
            '.write': 'auth != null',
          },
          entries: {
            $entryKey: {
              '.write': 'auth != null',
            },
          },
        },
      },
    });

    const overbroad = coverageMatrixPass(usage, surface).filter(
      (d) => d.code === 'overbroad-auth-only-write',
    );
    expect(overbroad.length).toBe(5);

    for (const d of overbroad) {
      expect(d.remediation.includes('callerUid')).toBe(false);
    }

    const fsAffix = overbroad.find(
      (d) => d.service === 'firestore' && d.remediation.includes("id == 'user_'"),
    )!;
    expect(fsAffix.remediation).toContain("id == 'user_' + request.auth.uid");
    expect(fsAffix.remediation.includes('request.auth.uid == id')).toBe(false);

    const fsComposite = overbroad.find(
      (d) => d.service === 'firestore' && d.remediation.includes('sessionKey'),
    )!;
    expect(fsComposite.remediation.includes('request.auth.uid == sessionKey')).toBe(false);

    const rtdbAffix = overbroad.find(
      (d) => d.service === 'rtdb' && d.remediation.includes('$entryKey'),
    )!;
    expect(rtdbAffix.remediation).toContain("$entryKey === 'user_' + auth.uid");
  });

  it('does not rewrite (default) Storage operations onto named-bucket runtime observations when defaultBucket is unset', () => {
    const surface = projectRuleSurface({
      storage: [
        {
          source: 'default.storage.rules',
          text: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow read, write: if true;
    }
  }
}`,
        },
        {
          source: 'docs.storage.rules',
          bucket: 'docs-bucket',
          text: `rules_version = '2';
service firebase.storage {
  match /b/docs-bucket/o {
    match /items/{id} {
      allow write: if true;
      allow read: if false;
    }
  }
}`,
        },
      ],
    });

    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/read-default.ts': `
          import { getBytes, getStorage, ref } from 'firebase/storage';
          export async function readDefaultItem(id: string) {
            return getBytes(ref(getStorage(), \`items/\${id}\`));
          }
        `,
      },
    });

    const snapshot: SandboxSnapshot = {
      version: 1,
      rules: {},
      auth: { users: [] },
      firestore: {},
      rtdb: {},
      storage: {
        'docs-bucket': [
          {
            path: 'items/i1',
            contentBase64: '',
            size: 4,
            contentType: 'image/png',
          },
        ],
      },
    };

    const diags = coverageMatrixPass(usage, {
      ruleSurface: surface,
      runtime: { snapshot },
    });
    expect(
      diags.some((d) => d.code === 'uncovered-client-operation' && d.resourceId === 'docs-bucket'),
    ).toBe(false);
  });

  it('preserves composite RTDB segment affixes across rtdbIndexPass, checkRtdbIndexes, and mergeRtdbIndexes', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/rtdb-affix.ts': `
          import { get, getDatabase, orderByChild, query, ref } from 'firebase/database';
          export async function listUserItems(uid: string) {
            return get(query(ref(getDatabase(), \`users/user_\${uid}/items\`), orderByChild('rank')));
          }
        `,
      },
    });

    const passRes = rtdbIndexPass(usage);
    expect(passRes.requirements.length).toBe(1);
    expect(passRes.requirements[0]?.pattern.segments[1]).toEqual({
      kind: 'var',
      name: 'uid',
      prefix: 'user_',
    });

    const disjointSiblingRules = {
      rules: {
        users: {
          $uid: {
            items: {
              '.read': true,
              '.indexOn': ['rank'],
            },
          },
          docs: {
            '.read': true,
          },
        },
      },
    };
    expect(checkRtdbIndexes(disjointSiblingRules, passRes.requirements)).toEqual([]);
    const mergedClean = mergeRtdbIndexes(disjointSiblingRules, passRes.requirements);
    expect(mergedClean.changed).toBe(false);
    expect(mergedClean.addedCount).toBe(0);
    expect(
      ((mergedClean.rules.rules as Record<string, unknown>).users as Record<string, unknown>).docs,
    ).toEqual({ '.read': true });

    const matchingSiblingRules = {
      rules: {
        users: {
          $uid: {
            items: {
              '.read': true,
              '.indexOn': ['rank'],
            },
          },
          user_pinned: {
            '.read': true,
          },
          docs: {
            '.read': true,
          },
        },
      },
    };
    const shadowDiags = checkRtdbIndexes(matchingSiblingRules, passRes.requirements);
    expect(shadowDiags.length).toBe(1);
    expect(shadowDiags[0]?.ruleSite?.source).toBe('/users/user_pinned/items');

    const mergedShadow = mergeRtdbIndexes(matchingSiblingRules, passRes.requirements);
    expect(mergedShadow.changed).toBe(true);
    const usersNode = (mergedShadow.rules.rules as Record<string, unknown>).users as Record<
      string,
      Record<string, unknown>
    >;
    expect(usersNode.user_pinned?.items).toEqual({ '.indexOn': ['rank'] });
    expect(usersNode.docs?.items).toBeUndefined();
  });

  it('runs static passes without Node globalThis.process present', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/iso.ts': `
          import { getAuth } from 'firebase/auth';
          import { collection, getDocs, getFirestore, query, where } from 'firebase/firestore';
          import { get, getDatabase, orderByChild, query as rtdbQuery, ref as dbRef } from 'firebase/database';
          import { getStorage, ref as stRef, uploadBytes } from 'firebase/storage';
          export async function run() {
            const uid = getAuth().currentUser!.uid;
            await getDocs(query(collection(getFirestore(), 'users/u1/items'), where('editorId', '==', uid)));
            await get(rtdbQuery(dbRef(getDatabase(), \`users/user_\${uid}/items\`), orderByChild('rank')));
            await uploadBytes(stRef(getStorage(), 'items/i1'), new Uint8Array(4), { contentType: 'image/png' });
          }
        `,
      },
    });
    const fsRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/items/{id} {
      allow read: if request.auth != null && request.auth.uid == uid && resource.data.editorId == request.auth.uid;
    }
  }
}`;
    const stRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow read, write: if request.resource == null || request.resource.contentType.matches('image/.*');
    }
  }
}`;
    const rtdbRules = {
      rules: {
        users: {
          $uid: {
            items: {
              '.read': true,
              '.indexOn': ['rank'],
            },
          },
          docs: {
            '.read': true,
          },
        },
      },
    };
    const surface = projectRuleSurface({
      firestore: fsRules,
      storage: stRules,
      rtdb: rtdbRules,
    });

    const origDesc = Object.getOwnPropertyDescriptor(globalThis, 'process');
    Object.defineProperty(globalThis, 'process', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      expect(staticQueryProofPass(usage, fsRules)).toEqual([]);
      expect(storageContractPass(usage, stRules)).toEqual([]);
      const covDiags = coverageMatrixPass(usage, surface);
      expect(covDiags.filter((d) => d.code === 'uncovered-client-operation')).toEqual([]);
      expect(covDiags.map((d) => d.ruleSite?.source)).toEqual([
        'database.rules.json#/rules/users/docs/.read',
      ]);
      const rtdbRes = rtdbIndexPass(usage);
      expect(checkRtdbIndexes(rtdbRules, rtdbRes.requirements)).toEqual([]);
      expect(mergeRtdbIndexes(rtdbRules, rtdbRes.requirements).changed).toBe(false);
    } finally {
      if (origDesc) {
        Object.defineProperty(globalThis, 'process', origDesc);
      }
    }
  });
});
