import { describe, expect, it } from 'bun:test';
import { extractSdkUsage } from '../../../src/assurance-surface/code/usage-index.js';
import {
  collectExercisedProbes,
  entryMatchesProbe,
  extractOwnerWriteEvidence,
  formatOverbroadRemediation,
} from '../../../src/assurance-surface/passes/coverage-matrix-probes.js';
import { projectRuleSurface } from '../../../src/assurance-surface/rules/rule-surface.js';
import { renderResourcePattern } from '../../../src/sandbox/internal/resource-pattern.js';

describe('coverageMatrixPass probe matching and owner provenance helpers', () => {
  it('matches RTDB child .validate rules when code writes to an ancestor path', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/rtdb.ts': `
          import { getDatabase, ref, set, query, orderByChild } from 'firebase/database';
          export async function saveOrg(orgId: string) {
            const db = getDatabase();
            await set(ref(db, 'orgs/' + orgId), { title: 'Acme' });
            return query(ref(db, 'posts'), orderByChild('createdAt'));
          }
        `,
      },
    });

    const surface = projectRuleSurface({
      rtdb: {
        rules: {
          orgs: {
            $orgId: {
              '.write': 'auth != null',
              title: {
                '.validate': 'newData.isString()',
              },
            },
          },
          posts: {
            $postId: {
              '.read': 'auth != null',
            },
          },
          unrelated: {
            '.validate': 'newData.isNumber()',
          },
        },
      },
    });

    const probes = collectExercisedProbes(usage, [], undefined);
    const titleValidate = surface.entries.find(
      (e) => renderResourcePattern(e.pattern) === 'orgs/$orgId/title',
    )!;
    const postChildRead = surface.entries.find(
      (e) => renderResourcePattern(e.pattern) === 'posts/$postId',
    )!;
    const unrelatedValidate = surface.entries.find(
      (e) => renderResourcePattern(e.pattern) === 'unrelated',
    )!;

    expect(probes.some((p) => entryMatchesProbe(titleValidate, p, surface))).toBe(true);
    expect(probes.some((p) => entryMatchesProbe(postChildRead, p, surface))).toBe(true);
    expect(probes.some((p) => entryMatchesProbe(unrelatedValidate, p, surface))).toBe(false);
  });

  it('extracts customMetadata auth.uid provenance and formats Storage remediation', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/upload.ts': `
          import { getAuth } from 'firebase/auth';
          import { getStorage, ref, uploadBytes } from 'firebase/storage';
          export async function uploadAsset(bytes: Uint8Array) {
            const user = getAuth().currentUser!;
            await uploadBytes(ref(getStorage(), 'uploads/asset.png'), bytes, {
              customMetadata: { uploaderUid: user.uid },
            });
          }
        `,
      },
    });

    const surface = projectRuleSurface({
      storage: `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /uploads/{file} {
              allow write: if request.auth != null;
            }
          }
        }
      `,
    });

    const site = usage.operations[0]!;
    const evidence = extractOwnerWriteEvidence(site);
    expect(evidence?.metadataKeyName).toBe('uploaderUid');

    const remediation = formatOverbroadRemediation(surface.entries[0]!, evidence!);
    expect(remediation).toContain('request.resource.metadata.uploaderUid == request.auth.uid');
  });

  it('aligns auth.uid owner segment index on multi-wildcard Firestore, Storage, and RTDB rules and scopes wildcardBucket fallback', () => {
    const usage = extractSdkUsage({
      root: '/app',
      files: {
        'src/nested-owned.ts': `
          import { getAuth } from 'pyric/auth';
          import { getFirestore, doc, setDoc } from 'pyric/firestore';
          import { getDatabase, ref as dbRef, set } from 'pyric/database';
          import { getStorage, ref as stRef, uploadBytes } from 'pyric/storage';
          declare const app: unknown;

          export async function writeNested(orgId: string, itemId: string, noteId: string, fileName: string, bytes: Uint8Array) {
            const uid = getAuth().currentUser!.uid;
            await setDoc(doc(getFirestore(), 'users', uid, 'items', itemId), { title: 'Note' });
            await set(dbRef(getDatabase(), 'users/' + uid + '/notes/' + noteId), { body: 'hi' });
            const appBucket = getStorage(app, 'gs://tenant-assets');
            await uploadBytes(
              stRef(appBucket, 'orgs/' + orgId + '/avatars/' + uid + '/' + fileName),
              bytes,
            );
          }
        `,
      },
    });

    const surface = projectRuleSurface({
      firestore: `
        rules_version = '2';
        service cloud.firestore {
          match /databases/{database}/documents {
            match /users/{uid}/items/{itemId} {
              allow write: if request.auth != null;
            }
          }
        }
      `,
      rtdb: {
        rules: {
          users: {
            $uid: {
              notes: {
                $noteId: {
                  '.write': 'auth != null',
                },
              },
            },
          },
        },
      },
      storage: `
        rules_version = '2';
        service firebase.storage {
          match /b/{bucket}/o {
            match /orgs/{orgId}/avatars/{uid}/{fileName} {
              allow write: if request.auth != null;
            }
          }
          match /b/media-prod/o {
            match /public/{fileName} {
              allow read: if true;
            }
          }
        }
      `,
    });

    const fsSite = usage.operations.find((s) => s.service === 'firestore')!;
    const rtdbSite = usage.operations.find((s) => s.service === 'rtdb')!;
    const stSite = usage.operations.find((s) => s.service === 'storage')!;

    const fsEntry = surface.entries.find((e) => e.pattern.service === 'firestore')!;
    const rtdbEntry = surface.entries.find((e) => e.pattern.service === 'rtdb')!;
    const stWildcardEntry = surface.entries.find(
      (e) => e.pattern.service === 'storage' && e.wildcardBucket === true,
    )!;

    const fsRemediation = formatOverbroadRemediation(fsEntry, extractOwnerWriteEvidence(fsSite)!);
    expect(fsRemediation).toContain('request.auth.uid == uid');
    expect(fsRemediation).not.toContain('itemId');

    const rtdbRemediation = formatOverbroadRemediation(rtdbEntry, extractOwnerWriteEvidence(rtdbSite)!);
    expect(rtdbRemediation).toContain('auth.uid === $uid');
    expect(rtdbRemediation).not.toContain('auth.uid === $noteId');

    const stRemediation = formatOverbroadRemediation(
      stWildcardEntry,
      extractOwnerWriteEvidence(stSite)!,
    );
    expect(stRemediation).toContain('request.auth.uid == uid');
    expect(stRemediation).not.toContain('fileName');

    const probes = collectExercisedProbes(usage, [], undefined);
    expect(probes.some((p) => entryMatchesProbe(stWildcardEntry, p, surface))).toBe(true);
  });
});
