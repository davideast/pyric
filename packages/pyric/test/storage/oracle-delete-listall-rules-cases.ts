/**
 * Oracle conformance replay cases for `deleteObject`, root `listAll`, and
 * Storage Security Rules enforcement (`storage#63, #65, #75, #106..109`):
 *   - `client-storage-deleteobject-root-ref` (`storage#65`)
 *   - `storage-deleteobject-removes-bytes-and-metadata` (`storage#63`)
 *   - `storage-listall-root-ref` (`storage#75`)
 *   - `storage-rules-denied-metadata-and-delete` (`storage#106, #107, #108`)
 *   - `storage-rules-canonical-bucket-namespace` (`storage#109`)
 */
import { expect, it } from 'bun:test';
import { getAuth, signInAnonymously, signOut } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import {
  deleteObject,
  getBytes,
  getMetadata,
  getStorageSandbox,
  listAll,
  ref,
  updateMetadata,
  uploadBytes,
  type FirebaseStorage,
} from '../../src/storage/index.js';

export interface OracleDeleteListAllRulesSuiteContext {
  load: (name: string) => Record<string, unknown>;
  freshStorage: (label: string, rules?: string) => FirebaseStorage;
}

interface SandboxErrorOutcome {
  threw: boolean;
  code: string | null;
}

async function captureSandboxError(runOp: () => Promise<unknown>): Promise<SandboxErrorOutcome> {
  try {
    await runOp();
    return { threw: false, code: null };
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    let code: string | null = null;
    const rawCode = (err as { code?: unknown }).code;
    if (typeof rawCode === 'string') {
      code = rawCode;
    }
    return { threw: true, code };
  }
}

function isSortedByCodeUnits(values: readonly string[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1];
    const curr = values[i];
    if (prev !== undefined && curr !== undefined && prev > curr) {
      return false;
    }
  }
  return true;
}

export function registerOracleDeleteListAllRulesSuite({
  load,
  freshStorage,
}: OracleDeleteListAllRulesSuiteContext): void {
  it('storage#65: client-storage-deleteobject-root-ref throws storage/invalid-root-operation synchronously on the root reference', () => {
    const obs = load('client-storage-deleteobject-root-ref.json');
    const storage = freshStorage('deleteobject-root');
    const rootRef = ref(storage);

    expect(rootRef.fullPath).toBe(obs.rootFullPath as string);
    expect(rootRef.name).toBe(obs.rootName as string);
    expect(obs.isFirebaseError).toBe(true);
    expect(obs.errorName).toBe('FirebaseError');
    expect(obs.fetchCalls).toBe(0);
    expect((obs.message as string).length).toBeGreaterThan(0);

    let threwSync = false;
    let code: string | null = null;
    try {
      void deleteObject(rootRef);
    } catch (err) {
      threwSync = true;
      expect(err).toBeInstanceOf(Error);
      const rawCode = (err as { code?: unknown }).code;
      if (typeof rawCode === 'string') {
        code = rawCode;
      }
    }
    expect(threwSync).toBe(obs.threwSynchronously as boolean);
    expect(threwSync).toBe(obs.threw as boolean);
    expect(code).toBe(obs.code as string);
  });

  it('storage#63: storage-deleteobject-removes-bytes-and-metadata atomically removes both bytes and metadata', async () => {
    const obs = load('storage-deleteobject-removes-bytes-and-metadata.json');
    const storage = freshStorage('deleteobject-atomic');
    const targetRef = ref(storage, 'pyric_oracle/delete-atomic/item.bin');

    await uploadBytes(targetRef, new Uint8Array([16, 32, 48, 64]), {
      contentType: 'application/octet-stream',
      customMetadata: { tag: 'ephemeral' },
    });

    const beforeBuf = await getBytes(targetRef);
    const beforeMeta = await getMetadata(targetRef);
    const expectedBeforeBytes = obs.beforeDeleteBytes as Record<string, unknown>;
    const expectedBeforeMeta = obs.beforeDeleteMetadata as Record<string, unknown>;
    expect(expectedBeforeBytes.threw).toBe(false);
    expect(beforeBuf.byteLength).toBe(expectedBeforeBytes.byteLength as number);
    expect([...new Uint8Array(beforeBuf)]).toEqual(expectedBeforeBytes.bytes as number[]);
    expect(expectedBeforeMeta.threw).toBe(false);
    expect(beforeMeta.size).toBe(expectedBeforeMeta.size as number);
    expect(beforeMeta.contentType).toBe(expectedBeforeMeta.contentType as string);
    expect(beforeMeta.customMetadata).toEqual(
      expectedBeforeMeta.customMetadata as Record<string, string>,
    );

    const deleteOut = await deleteObject(targetRef);
    expect(deleteOut === undefined).toBe(obs.deleteResolvedUndefined as boolean);

    const expectedAfterBytes = obs.afterDeleteBytes as Record<string, unknown>;
    const expectedAfterMeta = obs.afterDeleteMetadata as Record<string, unknown>;
    expect(expectedAfterBytes.isFirebaseError).toBe(true);
    expect(expectedAfterMeta.isFirebaseError).toBe(true);

    const afterBytesErr = await captureSandboxError(() => getBytes(targetRef));
    expect(afterBytesErr).toEqual({
      threw: expectedAfterBytes.threw as boolean,
      code: expectedAfterBytes.code as string,
    });

    const afterMetaErr = await captureSandboxError(() => getMetadata(targetRef));
    expect(afterMetaErr).toEqual({
      threw: expectedAfterMeta.threw as boolean,
      code: expectedAfterMeta.code as string,
    });
  });

  it('storage#106, #107, #108: storage-rules-denied-metadata-and-delete rejects denied getMetadata, updateMetadata, and deleteObject with storage/unauthorized', async () => {
    const obs = load('storage-rules-denied-metadata-and-delete.json');
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /pyric_oracle/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;
    const sandbox = initializeSandbox({});
    try {
      const auth = getAuth(sandbox);
      await signInAnonymously(auth);
      const storage = getStorageSandbox(sandbox, {
        dbName: `pyric-storage-denied-ops-${Math.random().toString(36).slice(2, 10)}`,
        rules,
      });

      const protectedRef = ref(storage, 'pyric_oracle/run-1/denied-ops/protected.txt');
      const outsideRef = ref(storage, 'pyric_oracle_denied_ops/run-1/forbidden.txt');
      await uploadBytes(protectedRef, new Uint8Array([104, 101, 108, 108, 111]), {
        contentType: 'text/plain',
        customMetadata: { stage: 'initial' },
      });

      const outsideChecks: Array<{
        key: string;
        run: () => Promise<unknown>;
      }> = [
        { key: 'getMetadataOutsideGrant', run: () => getMetadata(outsideRef) },
        {
          key: 'updateMetadataOutsideGrant',
          run: () => updateMetadata(outsideRef, { customMetadata: { stage: 'mutated' } }),
        },
        { key: 'deleteObjectOutsideGrant', run: () => deleteObject(outsideRef) },
      ];

      for (const check of outsideChecks) {
        const expected = obs[check.key] as Record<string, unknown>;
        expect(expected.isFirebaseError).toBe(true);
        expect(await captureSandboxError(check.run)).toEqual({
          threw: expected.threw as boolean,
          code: expected.code as string,
        });
      }

      await signOut(auth);
      const signedOutChecks: Array<{
        key: string;
        run: () => Promise<unknown>;
      }> = [
        { key: 'getMetadataSignedOutExisting', run: () => getMetadata(protectedRef) },
        {
          key: 'updateMetadataSignedOutExisting',
          run: () => updateMetadata(protectedRef, { customMetadata: { stage: 'mutated' } }),
        },
        { key: 'deleteObjectSignedOutExisting', run: () => deleteObject(protectedRef) },
      ];

      for (const check of signedOutChecks) {
        const expected = obs[check.key] as Record<string, unknown>;
        expect(expected.isFirebaseError).toBe(true);
        expect(await captureSandboxError(check.run)).toEqual({
          threw: expected.threw as boolean,
          code: expected.code as string,
        });
      }

      await signInAnonymously(auth);
      const preserved = await getMetadata(protectedRef);
      expect({
        size: preserved.size,
        customMetadata: preserved.customMetadata ?? null,
      }).toEqual(obs.existingPreservedAfterDenials);
    } finally {
      sandbox.dispose();
    }
  });

  it('storage#109: storage-rules-canonical-bucket-namespace evaluates ordinary object paths under /b/{bucket}/o/... while preserving ordinary metadata paths', async () => {
    const obs = load('storage-rules-canonical-bucket-namespace.json');
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /pyric_oracle/{run}/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;
    const sandbox = initializeSandbox({});
    try {
      const auth = getAuth(sandbox);
      await signInAnonymously(auth);
      const storage = getStorageSandbox(sandbox, {
        dbName: `pyric-storage-canonical-ns-${Math.random().toString(36).slice(2, 10)}`,
        rules,
      });

      const ordinaryPath = 'pyric_oracle/<runId>/namespace-mapping/item.txt';
      const ordinaryRef = ref(storage, ordinaryPath);
      const uploaded = await uploadBytes(ordinaryRef, new Uint8Array([111, 107]), {
        contentType: 'text/plain',
      });
      const fetched = await getMetadata(ordinaryRef);

      expect({
        refFullPath: ordinaryRef.fullPath,
        uploadMetadataFullPath: uploaded.metadata.fullPath,
        fetchedMetadataFullPath: fetched.fullPath,
        fetchedMetadataName: fetched.name,
        startsWithCanonicalBucketPrefix: fetched.fullPath.startsWith('b/'),
        metadataMatchesRefFullPath: fetched.fullPath === ordinaryRef.fullPath,
      }).toEqual(obs.ordinaryObjectPath);

      const prefixedRef = ref(storage, `/b/${ordinaryRef.bucket}/o/${ordinaryPath}`);
      const expectedPrefixed = obs.explicitRulesPrefixPath as Record<string, unknown>;
      expect(expectedPrefixed.uploadIsFirebaseError).toBe(true);
      expect(prefixedRef.fullPath.startsWith('b/')).toBe(
        expectedPrefixed.normalizedRefStartsWithB as boolean,
      );
      const prefixedUpload = await captureSandboxError(() =>
        uploadBytes(prefixedRef, new Uint8Array([111, 107])),
      );
      expect(prefixedUpload).toEqual({
        threw: expectedPrefixed.uploadThrew as boolean,
        code: expectedPrefixed.uploadCode as string,
      });
    } finally {
      sandbox.dispose();
    }
  });

  it('storage#75: storage-listall-root-ref lists direct root items and top-level prefixes without recursing', async () => {
    const obs = load('storage-listall-root-ref.json');
    const storage = freshStorage(
      'listall-root',
      `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}`,
    );

    const rootItemName = 'pyric_oracle_root_r1.bin';
    const rootPrefixName = 'pyric_oracle_root_r1';
    const nestedChildFullPath = 'pyric_oracle_root_r1/nested/child.bin';

    await uploadBytes(ref(storage, rootItemName), new Uint8Array([0x41]));
    await uploadBytes(ref(storage, nestedChildFullPath), new Uint8Array([0x42, 0x43]));
    await uploadBytes(
      ref(storage, 'pyric_oracle_root_r1-dash/nested/child.bin'),
      new Uint8Array([0x44]),
    );

    const rootRef = ref(storage);
    const res = await listAll(rootRef);
    expect(res.prefixes.map((prefix) => prefix.fullPath)).toEqual([
      'pyric_oracle_root_r1-dash',
      'pyric_oracle_root_r1',
    ]);
    const observed = {
      rootFullPath: rootRef.fullPath,
      rootName: rootRef.name,
      rootParentIsNull: rootRef.parent === null,
      containsSeededRootItem: res.items.some(
        (item) =>
          item.fullPath === rootItemName &&
          item.name === rootItemName &&
          item.parent !== null &&
          item.parent.fullPath === '',
      ),
      containsSeededRootPrefix: res.prefixes.some(
        (prefix) =>
          prefix.fullPath === rootPrefixName &&
          prefix.name === rootPrefixName &&
          prefix.parent !== null &&
          prefix.parent.fullPath === '',
      ),
      nestedChildExcludedFromRootItems: !res.items.some(
        (item) => item.fullPath === nestedChildFullPath || item.fullPath.includes('/'),
      ),
      itemsSortedLexicographically: isSortedByCodeUnits(res.items.map((item) => item.fullPath)),
      prefixesSortedLexicographically: isSortedByCodeUnits(
        res.prefixes.map((prefix) => prefix.fullPath),
      ),
      nextPageTokenIsUndefined: res.nextPageToken === undefined,
    };

    expect(observed).toEqual(obs);
  });
}
