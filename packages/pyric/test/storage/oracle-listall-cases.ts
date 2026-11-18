/**
 * Oracle conformance replay cases for `listAll(ref)` (`storage#68..74, #76, #77a`):
 *   - `storage-listall-empty-and-result-shape` (`storage#68, #69, #76`)
 *   - `storage-listall-hierarchy-dedup-and-self-exclusion` (`storage#70, #71, #74`)
 *   - `storage-listall-lexicographic-order` (`storage#72, #73`)
 *   - `storage-listall-rules-enforcement` (`storage#77a`)
 */
import { expect, it } from 'bun:test';
import { getAuth, signInAnonymously, signOut } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getMetadata,
  getStorageSandbox,
  listAll,
  ref,
  uploadBytes,
  type FirebaseStorage,
  type StorageReference,
} from '../../src/storage/index.js';

export interface OracleListAllSuiteContext {
  load: (name: string) => Record<string, unknown>;
  freshStorage: (label: string, rules?: string) => FirebaseStorage;
}

interface ListedRefExpectation {
  name: string;
  scrubbedFullPath: string;
  storageMatchesHandle: boolean;
  bucketMatchesHandle: boolean;
  parentMatchesScannedRef: boolean;
  rootFullPath: string;
  toStringMatchesGsUri: boolean;
}

interface ListAttemptExpectation {
  threw: boolean;
  code: string | null;
  isFirebaseError: boolean;
  itemNames: string[];
}

function assertListedRefShape(
  actual: StorageReference,
  scannedRef: StorageReference,
  storage: FirebaseStorage,
  expected: ListedRefExpectation,
): void {
  expect(actual.name).toBe(expected.name);
  expect(actual.fullPath).toBe(expected.scrubbedFullPath);
  expect(actual.storage === storage).toBe(expected.storageMatchesHandle);
  expect(actual.bucket === scannedRef.bucket).toBe(expected.bucketMatchesHandle);
  let parentMatches = false;
  if (actual.parent !== null) {
    parentMatches = actual.parent.fullPath === scannedRef.fullPath;
  }
  expect(parentMatches).toBe(expected.parentMatchesScannedRef);
  expect(actual.root.fullPath).toBe(expected.rootFullPath);
  const expectedUri = `gs://${scannedRef.bucket}/${actual.fullPath}`;
  expect(actual.toString() === expectedUri).toBe(expected.toStringMatchesGsUri);
}

async function runListAttempt(
  targetRef: StorageReference,
): Promise<Omit<ListAttemptExpectation, 'isFirebaseError'>> {
  try {
    const res = await listAll(targetRef);
    return {
      threw: false,
      code: null,
      itemNames: res.items.map((item) => item.name),
    };
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    let code: string | null = null;
    const rawCode = (err as { code?: unknown }).code;
    if (typeof rawCode === 'string') {
      code = rawCode;
    }
    return {
      threw: true,
      code,
      itemNames: [],
    };
  }
}

export function registerOracleListAllSuite({
  load,
  freshStorage,
}: OracleListAllSuiteContext): void {
  it('storage#68, #69, #76: storage-listall-empty-and-result-shape replays empty/populated ListResult and StorageReference properties', async () => {
    const obs = load('storage-listall-empty-and-result-shape.json');
    const storage = freshStorage('listall-shape');

    const emptyExpected = obs.emptyDirectory as {
      itemCount: number;
      prefixCount: number;
      nextPageTokenIsUndefined: boolean;
      hasNextPageTokenOwnProperty: boolean;
    };
    const emptyRef = ref(storage, 'pyric_oracle/<runId>/listall-shape-empty');
    const emptyRes = await listAll(emptyRef);
    const emptyRaw = emptyRes as unknown as Record<string, unknown>;
    expect(emptyRes.items.length).toBe(emptyExpected.itemCount);
    expect(emptyRes.prefixes.length).toBe(emptyExpected.prefixCount);
    expect(emptyRaw.nextPageToken === undefined).toBe(emptyExpected.nextPageTokenIsUndefined);
    expect(Object.prototype.hasOwnProperty.call(emptyRaw, 'nextPageToken')).toBe(
      emptyExpected.hasNextPageTokenOwnProperty,
    );

    await uploadBytes(
      ref(storage, 'pyric_oracle/<runId>/listall-shape-populated/direct.bin'),
      new Uint8Array([0x01]),
    );
    await uploadBytes(
      ref(storage, 'pyric_oracle/<runId>/listall-shape-populated/nested-folder/child.bin'),
      new Uint8Array([0x01]),
    );

    const populatedExpected = obs.populatedDirectory as {
      itemCount: number;
      prefixCount: number;
      nextPageTokenIsUndefined: boolean;
      hasNextPageTokenOwnProperty: boolean;
      items: ListedRefExpectation[];
      prefixes: ListedRefExpectation[];
    };
    const popRef = ref(storage, 'pyric_oracle/<runId>/listall-shape-populated');
    const popRes = await listAll(popRef);
    const popRaw = popRes as unknown as Record<string, unknown>;
    expect(popRes.items.length).toBe(populatedExpected.itemCount);
    expect(popRes.prefixes.length).toBe(populatedExpected.prefixCount);
    expect(popRaw.nextPageToken === undefined).toBe(populatedExpected.nextPageTokenIsUndefined);
    expect(Object.prototype.hasOwnProperty.call(popRaw, 'nextPageToken')).toBe(
      populatedExpected.hasNextPageTokenOwnProperty,
    );
    assertListedRefShape(popRes.items[0], popRef, storage, populatedExpected.items[0]);
    assertListedRefShape(popRes.prefixes[0], popRef, storage, populatedExpected.prefixes[0]);
  });

  it('storage#70, #71, #74: storage-listall-hierarchy-dedup-and-self-exclusion replays self-exclusion, non-recursion, and prefix deduplication', async () => {
    const obs = load('storage-listall-hierarchy-dedup-and-self-exclusion.json');
    const storage = freshStorage('listall-hierarchy');

    await uploadBytes(ref(storage, 'scan-tree'), new Uint8Array([0x41, 0x42, 0x43]));
    await uploadBytes(ref(storage, 'scan-tree/direct-two.bin'), new Uint8Array([0x41]));
    await uploadBytes(ref(storage, 'scan-tree/direct-one.bin'), new Uint8Array([0x41]));
    await uploadBytes(ref(storage, 'scan-tree/shared-folder/part-a.bin'), new Uint8Array([0x41]));
    await uploadBytes(ref(storage, 'scan-tree/shared-folder/part-b.bin'), new Uint8Array([0x41]));
    await uploadBytes(ref(storage, 'scan-tree/shared-folder/part-c.bin'), new Uint8Array([0x41]));
    await uploadBytes(
      ref(storage, 'scan-tree/deep-folder/nested/grandchild.bin'),
      new Uint8Array([0x41]),
    );

    const exactMd = await getMetadata(ref(storage, 'scan-tree'));
    expect(exactMd.size > 0).toBe(obs.exactPrefixObjectExists as boolean);

    const listed = await listAll(ref(storage, 'scan-tree'));
    const fullPaths = listed.items.map((item) => item.fullPath);
    expect(fullPaths.includes('scan-tree')).toBe(obs.scannedRefIncludedInItems as boolean);
    expect(fullPaths.some((p) => p.slice('scan-tree/'.length).includes('/'))).toBe(
      obs.grandchildrenIncludedInItems as boolean,
    );
    expect(listed.items.map((item) => item.name)).toEqual(obs.itemNames as string[]);
    expect(listed.prefixes.map((prefix) => prefix.name)).toEqual(obs.prefixNames as string[]);
  });

  it('storage#72, #73: storage-listall-lexicographic-order replays deterministic item and prefix ordering', async () => {
    const obs = load('storage-listall-lexicographic-order.json');
    const storage = freshStorage('listall-order');

    for (const itemName of obs.uploadedItemOrder as string[]) {
      await uploadBytes(ref(storage, `listall-order/${itemName}`), new Uint8Array([0x01]));
    }
    for (const prefixName of obs.uploadedPrefixOrder as string[]) {
      await uploadBytes(ref(storage, `listall-order/${prefixName}/leaf.bin`), new Uint8Array([0x01]));
    }

    const listed = await listAll(ref(storage, 'listall-order'));
    expect(listed.items.map((item) => item.name)).toEqual(obs.observedItemNames as string[]);
    expect(listed.prefixes.map((prefix) => prefix.name)).toEqual(obs.observedPrefixNames as string[]);
  });

  it('storage#77a: storage-listall-rules-enforcement replays authed read grant vs unauthorized denials', async () => {
    const obs = load('storage-listall-rules-enforcement.json');
    const rules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /pyric_oracle/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;
    const sandbox = initializeSandbox({});
    const auth = getAuth(sandbox);
    await signInAnonymously(auth);
    const storage = getStorageSandbox(sandbox, {
      dbName: `pyric-storage-listall-rules-${Math.random().toString(36).slice(2, 10)}`,
      rules,
    });

    await uploadBytes(
      ref(storage, 'pyric_oracle/run-1/listall-rules/allowed-dir/visible.bin'),
      new Uint8Array([0x07]),
    );

    const allowedExpected = obs.authenticatedAllowed as ListAttemptExpectation;
    const allowedOutcome = await runListAttempt(
      ref(storage, 'pyric_oracle/run-1/listall-rules/allowed-dir'),
    );
    expect(allowedExpected.isFirebaseError).toBe(false);
    expect(allowedOutcome).toEqual({
      threw: allowedExpected.threw,
      code: allowedExpected.code,
      itemNames: allowedExpected.itemNames,
    });

    const outsideExpected = obs.authenticatedOutsideGrant as ListAttemptExpectation;
    const outsideOutcome = await runListAttempt(
      ref(storage, 'pyric_oracle_denied_list/run-1/forbidden-dir'),
    );
    // Upstream throws FirebaseError; in-process sandbox throws StorageError (storage#105).
    expect(outsideExpected.isFirebaseError).toBe(true);
    expect(outsideOutcome).toEqual({
      threw: outsideExpected.threw,
      code: outsideExpected.code,
      itemNames: outsideExpected.itemNames,
    });

    await signOut(auth);
    const signedOutExpected = obs.signedOutOnAuthRequiredPath as ListAttemptExpectation;
    const signedOutOutcome = await runListAttempt(
      ref(storage, 'pyric_oracle/run-1/listall-rules/allowed-dir'),
    );
    expect(signedOutExpected.isFirebaseError).toBe(true);
    expect(signedOutOutcome).toEqual({
      threw: signedOutExpected.threw,
      code: signedOutExpected.code,
      itemNames: signedOutExpected.itemNames,
    });
  });
}
