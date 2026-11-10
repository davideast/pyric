import { describe, expect, it } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import { coverageMatrixPass } from '../../../src/assurance-surface/passes/coverage-matrix.js';
import { projectRuleSurface } from '../../../src/assurance-surface/rules/rule-surface.js';
import { renderResourcePattern } from '../../../src/sandbox/internal/resource-pattern.js';
import type { SandboxSnapshot } from '../../../src/sandbox/internal/snapshot-codec.js';
import type { SandboxEvent } from '../../../src/sandbox/types/events.js';

describe('coverageMatrixPass', () => {
  it('flags uncovered client operations for both omitted rules and always-false rules while skipping admin SDK ops', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/client.ts': `
          import { getFirestore, doc, getDoc, collection, getDocs, collectionGroup } from 'firebase/firestore';
          import { getStorage, ref, getBytes, listAll } from 'firebase/storage';
          import { getAdminFirestore } from 'pyric-admin/firestore';

          export async function runClient(orgId: string) {
            const db = getFirestore();
            await getDoc(doc(db, 'secretDocs', 'd1'));
            await getDoc(doc(db, 'lockedDocs', 'd2'));
            await getDocs(collection(db, 'orgs', orgId, 'items'));
            await getDocs(collectionGroup(db, 'items'));

            const storage = getStorage(undefined, 'gs://media-bucket');
            await listAll(ref(storage, 'orgs/' + orgId));
            await getBytes(ref(storage, 'unprotected/report.csv'));
          }

          export async function runAdmin() {
            const adminDb = getAdminFirestore();
            await getDoc(doc(adminDb, 'serverOnly', 'cfg'));
          }
        `,
      },
    });

    const surface = projectRuleSurface({
      firestore: `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /lockedDocs/{docId} {
              allow read: if false;
            }
            match /orgs/{orgId}/items/{itemId} {
              allow read: if request.auth != null;
            }
          }
        }
      `,
      storage: `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /orgs/{orgId}/{fileName} {
              allow list: if request.auth != null;
            }
          }
        }
      `,
    });

    const diagnostics = coverageMatrixPass(usage, surface);
    const uncovered = diagnostics.filter((d) => d.code === 'uncovered-client-operation');

    expect(uncovered.map((d) => `${d.service}:${renderResourcePattern(d.resource!)}`)).toEqual([
      'firestore:{path=**}/items',
      'firestore:secretDocs/d1',
      'firestore:lockedDocs/d2',
      'storage:unprotected/report.csv',
    ]);
    for (const diag of uncovered) {
      expect(diag.certainty).toBe('static-proof');
      expect(diag.severity).toBe('high');
    }

    const lockedDiag = uncovered.find((d) => renderResourcePattern(d.resource!) === 'lockedDocs/d2');
    expect(lockedDiag?.ruleSite?.source).toContain('firestore.rules:');
    expect(uncovered.some((d) => renderResourcePattern(d.resource!).includes('serverOnly'))).toBe(false);
  });

  it('respects RTDB cascading .read/.write inheritance from ancestors while catching uncovered parent reads', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/rtdb.ts': `
          import { getDatabase, ref, get, set } from 'firebase/database';

          export async function syncOrg(orgId: string) {
            const db = getDatabase();
            await get(ref(db, 'orgs/' + orgId + '/items/1'));
            await set(ref(db, 'orgs/' + orgId + '/items/1'), { name: 'Widget' });
            await get(ref(db, 'orgs'));
            await get(ref(db, 'closedBranch/node1'));
          }
        `,
      },
    });

    const surface = projectRuleSurface({
      rtdb: {
        rules: {
          orgs: {
            $orgId: {
              '.read': 'auth != null',
              '.write': 'auth != null && auth.uid === $orgId',
            },
          },
          closedBranch: {
            '.read': false,
          },
        },
      },
    });

    const diagnostics = coverageMatrixPass(usage, surface);
    const uncovered = diagnostics.filter((d) => d.code === 'uncovered-client-operation');

    expect(uncovered.map((d) => renderResourcePattern(d.resource!))).toEqual([
      'orgs',
      'closedBranch/node1',
    ]);
    expect(uncovered[0]?.certainty).toBe('static-proof');
    expect(uncovered[1]?.ruleSite?.expression).toBe('false');
  });

  it('concretizes partial client paths from SandboxSnapshot and history and attaches runtimeSite evidence', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/dynamic.ts': `
          import { doc, getDoc } from 'firebase/firestore';

          declare function untypedDb(): unknown;
          declare function pickTenant(): string;

          export async function loadTenantItem() {
            const db = untypedDb();
            await getDoc(doc(db, 'orgs/' + pickTenant() + '/items/1'));
          }
        `,
      },
    });
    expect(usage.operations[0]?.resolution).toBe('partial');

    const surface = projectRuleSurface({
      firestore: `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /orgs/beta/items/{itemId} {
              allow get: if request.auth != null;
            }
            match /orgs/{orgId}/members/{uid} {
              allow get: if request.auth != null && request.auth.uid == uid;
            }
          }
        }
      `,
    });

    const snapshot: SandboxSnapshot = {
      version: 1,
      rules: {},
      auth: { users: [] },
      firestore: {
        '(default)': {
          'orgs/acme/members/u1': { role: 'member' },
        },
      },
      rtdb: {},
      storage: {},
    };

    const history: SandboxEvent[] = [
      {
        kind: 'request',
        id: 'req-42',
        at: 200,
        evalMs: 1,
        method: 'get',
        path: 'orgs/beta/items/9',
        auth: { uid: 'u1' },
        result: 'allow',
        reasons: [],
        origin: 'user',
      },
    ];

    const diagnostics = coverageMatrixPass(usage, surface, { snapshot, history });
    const partialUncovered = diagnostics.find(
      (d) =>
        d.code === 'uncovered-client-operation'
        && renderResourcePattern(d.resource!) === 'orgs/acme/items/1',
    );

    expect(partialUncovered).toBeDefined();
    expect(partialUncovered?.certainty).toBe('heuristic');
    expect(partialUncovered?.severity).toBe('medium');
    expect(partialUncovered?.runtimeSite).toEqual({
      source: 'snapshot:firestore:(default)',
      concretePath: 'orgs/acme/members/u1',
    });
  });

  it('flags orphaned security rules with 0 code and 0 runtime matches without false-positiving on catch-all deny rules', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/app.ts': `
          import { getFirestore, collection, getDocs } from 'firebase/firestore';
          import { getAdminFirestore } from 'pyric-admin/firestore';
          import { doc } from 'firebase/firestore';

          export async function readActive() {
            const db = getFirestore();
            await getDocs(collection(db, 'items'));
            const adminDb = getAdminFirestore();
            return doc(adminDb, 'auditLogs', 'entry1');
          }
        `,
      },
    });

    const surface = projectRuleSurface({
      firestore: `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /items/{itemId} {
              allow read: if true;
            }
            match /auditLogs/{logId} {
              allow read: if request.auth != null;
            }
            match /seededOnly/{docId} {
              allow read: if request.auth != null;
            }
            match /legacyArchive/{archiveId} {
              allow read: if request.auth != null;
            }
            match /{document=**} {
              allow read, write: if false;
            }
          }
        }
      `,
      rtdb: {
        rules: {
          indexedOnly: {
            '.indexOn': ['createdAt'],
          },
          unusedFeed: {
            $postId: {
              '.read': 'auth != null',
            },
          },
        },
      },
    });

    const snapshot: SandboxSnapshot = {
      version: 1,
      rules: {},
      auth: { users: [] },
      firestore: {
        '(default)': {
          'seededOnly/s1': { active: true },
        },
      },
      rtdb: {},
      storage: {},
    };

    const diagnostics = coverageMatrixPass(usage, surface, { snapshot });
    const orphaned = diagnostics.filter((d) => d.code === 'orphaned-security-rule');

    expect(orphaned.map((d) => `${d.service}:${renderResourcePattern(d.resource!)}`)).toEqual([
      'firestore:legacyArchive/{archiveId}',
      'rtdb:unusedFeed/$postId',
    ]);
    for (const diag of orphaned) {
      expect(diag.certainty).toBe('heuristic');
      expect(diag.severity).toBe('low');
    }
  });

  it('flags overbroad auth-only write rules when client writes carry owner-scoped path or payload provenance', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/writes.ts': `
          import { getAuth } from 'firebase/auth';
          import { getFirestore, doc, setDoc, collection, addDoc } from 'firebase/firestore';
          import { getDatabase, ref as dbRef, set } from 'firebase/database';
          import { getStorage, ref as stRef, uploadBytes } from 'firebase/storage';

          export async function saveOwnedData(boardId: string, bytes: Uint8Array) {
            const user = getAuth().currentUser!;
            const db = getFirestore();
            await setDoc(doc(db, 'users', user.uid), { displayName: 'Ada' });
            await addDoc(collection(db, 'notes'), { ownerId: user.uid, text: 'hello' });
            await setDoc(doc(db, 'sharedBoards', boardId), { title: 'Roadmap' });

            const rtdb = getDatabase();
            await set(dbRef(rtdb, 'profiles/' + user.uid), { online: true });

            const storage = getStorage();
            await uploadBytes(stRef(storage, 'files/' + user.uid + '/avatar.png'), bytes);
          }
        `,
      },
    });

    const surface = projectRuleSurface({
      firestore: `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /users/{userId} {
              allow write: if request.auth != null;
            }
            match /notes/{noteId} {
              allow create: if request.auth != null;
            }
            match /sharedBoards/{boardId} {
              allow write: if request.auth != null;
            }
          }
        }
      `,
      rtdb: {
        rules: {
          profiles: {
            $uid: {
              '.write': 'auth != null',
            },
          },
        },
      },
      storage: `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /files/{uid}/{allPaths=**} {
              allow write: if request.auth != null;
            }
          }
        }
      `,
    });

    const diagnostics = coverageMatrixPass(usage, surface);
    const overbroad = diagnostics.filter((d) => d.code === 'overbroad-auth-only-write');

    expect(overbroad.map((d) => `${d.service}:${renderResourcePattern(d.resource!)}`)).toEqual([
      'firestore:users/{userId}',
      'firestore:notes/{noteId}',
      'rtdb:profiles/$uid',
      'storage:files/{uid}/{allPaths=**}',
    ]);

    for (const diag of overbroad) {
      expect(diag.certainty).toBe('heuristic');
      expect(diag.severity).toBe('medium');
      if (diag.service === 'rtdb') {
        expect(diag.remediation).toContain('auth.uid');
      } else {
        expect(diag.remediation).toContain('request.auth.uid');
      }
    }
    expect(overbroad.some((d) => renderResourcePattern(d.resource!) === 'sharedBoards/{boardId}')).toBe(false);
  });

  it('runs cleanly when globalThis.process is undefined (browser-clean guarantee)', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/browser.ts': `
          import { getFirestore, doc, getDoc } from 'firebase/firestore';
          export async function load() {
            await getDoc(doc(getFirestore(), 'missing', '1'));
          }
        `,
      },
    });
    const surface = projectRuleSurface({
      firestore: `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {}
        }
      `,
    });

    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process');
    Object.defineProperty(globalThis, 'process', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const diagnostics = coverageMatrixPass(usage, surface);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.code).toBe('uncovered-client-operation');
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, 'process', descriptor);
      }
    }
  });

  it('flags RTDB non-empty array writes and objects containing non-empty array fields against .validate: false', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/rtdb-arrays.ts': `
          import { getDatabase, ref, set } from 'firebase/database';
          export async function writeArrays() {
            const db = getDatabase();
            await set(ref(db, 'items/arr'), ['a', 'b']);
            await set(ref(db, 'items/objWithArr'), { tags: ['a', 'b'] });
            await set(ref(db, 'items/emptyArr'), []);
          }
        `,
      },
    });
    const surface = projectRuleSurface({
      rtdb: {
        rules: {
          items: {
            $id: { '.write': 'auth != null', '.validate': false },
          },
        },
      },
    });

    const uncovered = coverageMatrixPass(usage, surface).filter(
      (d) => d.code === 'uncovered-client-operation' && d.certainty === 'static-proof',
    );
    expect(uncovered.map((d) => renderResourcePattern(d.resource!))).toEqual([
      'items/arr',
      'items/objWithArr',
    ]);
  });
});
