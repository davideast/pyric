/**
 * Oracle conformance replay cases for `ref()` (`storage#13..23`):
 *   - `client-storage-ref-root-and-segments` (`storage#13, #14, #21`)
 *   - `client-storage-ref-slash-normalization` (`storage#15, #16, #17`)
 *   - `client-storage-ref-hierarchy-and-traversal` (`storage#18, #19, #20`)
 *   - `client-storage-ref-identity-and-storage-handle` (`storage#22, #23`)
 */
import { expect, it } from 'bun:test';
import { ref, type FirebaseStorage, type StorageReference } from '../../src/storage/index.js';

export interface OracleRefSuiteContext {
  load: (name: string) => Record<string, unknown>;
  freshStorage: (label: string) => FirebaseStorage;
}

interface RefSnapshotExpectation {
  fullPath: string;
  name: string;
  hasParent: boolean;
  parentFullPath: string | null;
  rootFullPath: string;
}

function assertMatchesSnapshot(actual: StorageReference, expected: RefSnapshotExpectation): void {
  expect(actual.fullPath).toBe(expected.fullPath);
  expect(actual.name).toBe(expected.name);
  expect(actual.parent !== null).toBe(expected.hasParent);
  if (actual.parent === null) {
    expect(expected.parentFullPath).toBeNull();
  } else {
    expect(actual.parent.fullPath).toBe(expected.parentFullPath as string);
  }
  expect(actual.root.fullPath).toBe(expected.rootFullPath);
  expect(actual.toString()).toBe(`gs://${actual.bucket}/${expected.fullPath}`);
}

function walkChain(start: StorageReference): Array<{ fullPath: string; name: string }> {
  const steps: Array<{ fullPath: string; name: string }> = [];
  let cursor: StorageReference | null = start;
  while (cursor !== null) {
    steps.push({ fullPath: cursor.fullPath, name: cursor.name });
    cursor = cursor.parent;
  }
  return steps;
}

export function registerOracleRefSuite(ctx: OracleRefSuiteContext): void {
  it('storage#13, #14, #21: ref(storage) and ref(storage, path) match root, segment, and gs:// toString semantics', () => {
    const obs = ctx.load('client-storage-ref-root-and-segments.json');
    const storage = ctx.freshStorage('ref-root-segments');

    const bareExpected = obs.bareRoot as RefSnapshotExpectation & {
      rootStrictEqualSelf: boolean;
      rootToStringMatchesSelf: boolean;
    };
    const bareRoot = ref(storage);
    assertMatchesSnapshot(bareRoot, bareExpected);
    expect(bareRoot.root === bareRoot).toBe(bareExpected.rootStrictEqualSelf);
    expect(bareRoot.root.toString() === bareRoot.toString()).toBe(
      bareExpected.rootToStringMatchesSelf,
    );

    assertMatchesSnapshot(ref(storage, ''), obs.emptyStringRoot as RefSnapshotExpectation);
    assertMatchesSnapshot(ref(storage, 'readme.txt'), obs.singleSegment as RefSnapshotExpectation);
    assertMatchesSnapshot(
      ref(storage, 'sessions/s1.json'),
      obs.nestedSegments as RefSnapshotExpectation,
    );
    assertMatchesSnapshot(
      ref(storage, 'orgs/acme/projects/p1/report.csv'),
      obs.deepSegments as RefSnapshotExpectation,
    );
  });

  it('storage#15, #16, #17: ref(storage, path) strips leading/trailing slashes and collapses internal slashes', () => {
    const obs = ctx.load('client-storage-ref-slash-normalization.json');
    const storage = ctx.freshStorage('ref-slash-norm');

    assertMatchesSnapshot(
      ref(storage, '/sessions/s1'),
      obs.singleLeadingSlash as RefSnapshotExpectation,
    );
    assertMatchesSnapshot(
      ref(storage, '///sessions/s1'),
      obs.multipleLeadingSlashes as RefSnapshotExpectation,
    );
    assertMatchesSnapshot(
      ref(storage, 'sessions/s1/'),
      obs.singleTrailingSlash as RefSnapshotExpectation,
    );
    assertMatchesSnapshot(
      ref(storage, 'sessions/s1///'),
      obs.multipleTrailingSlashes as RefSnapshotExpectation,
    );
    assertMatchesSnapshot(
      ref(storage, 'a//b'),
      obs.repeatedInternalSlashes as RefSnapshotExpectation,
    );
    assertMatchesSnapshot(
      ref(storage, 'a////b///c'),
      obs.manyInternalSlashes as RefSnapshotExpectation,
    );
    assertMatchesSnapshot(
      ref(storage, '///a//b/c///'),
      obs.combinedSlashes as RefSnapshotExpectation,
    );
    assertMatchesSnapshot(ref(storage, '////'), obs.onlySlashes as RefSnapshotExpectation);
  });

  it('storage#18, #19, #20: ref(parent, child), parent chain traversal, and root accessor match production across depths', () => {
    const obs = ctx.load('client-storage-ref-hierarchy-and-traversal.json');
    const storage = ctx.freshStorage('ref-hierarchy');

    const rootRef = ref(storage);
    const folderRef = ref(storage, 'users/u1');

    assertMatchesSnapshot(
      ref(rootRef, 'items/doc.txt'),
      obs.childFromRoot as RefSnapshotExpectation,
    );
    assertMatchesSnapshot(
      ref(folderRef, 'avatars/profile.png'),
      obs.childFromFolder as RefSnapshotExpectation,
    );
    assertMatchesSnapshot(
      ref(ref(storage, '/users//u1/'), '//avatars//banner.png/'),
      obs.slashyChildJoin as RefSnapshotExpectation,
    );
    assertMatchesSnapshot(ref(folderRef, ''), obs.emptyChildJoin as RefSnapshotExpectation);
    assertMatchesSnapshot(ref(folderRef, '///'), obs.slashOnlyChildJoin as RefSnapshotExpectation);

    const depth3 = ref(storage, 'alpha/beta/gamma');
    const depth1 = ref(storage, 'alpha');
    expect(walkChain(depth3)).toEqual(
      obs.parentChainFromDepth3 as Array<{ fullPath: string; name: string }>,
    );
    expect(rootRef.parent === null).toBe(obs.terminalParentIsNull as boolean);

    assertMatchesSnapshot(rootRef.root, obs.rootAtDepth0 as RefSnapshotExpectation);
    assertMatchesSnapshot(depth1.root, obs.rootAtDepth1 as RefSnapshotExpectation);
    assertMatchesSnapshot(depth3.root, obs.rootAtDepth3 as RefSnapshotExpectation);
  });

  it('storage#22, #23: references are non-interned value objects preserving owning storage handle and bucket', () => {
    const obs = ctx.load('client-storage-ref-identity-and-storage-handle.json');
    const storage = ctx.freshStorage('ref-identity');
    const handleBucket = ref(storage).bucket;

    const firstSamePath = ref(storage, 'a/b');
    const secondSamePath = ref(storage, 'a/b');
    const rootFirst = ref(storage);
    const rootSecond = ref(storage);
    const firstParent = firstSamePath.parent;
    const secondParent = firstSamePath.parent;
    expect(firstParent).not.toBeNull();
    expect(secondParent).not.toBeNull();
    if (firstParent === null || secondParent === null) return;

    const firstRoot = firstSamePath.root;
    const secondRoot = firstSamePath.root;
    const childFromParent = ref(firstParent, 'b');

    expect(firstSamePath === secondSamePath).toBe(obs.samePathStrictEqual as boolean);
    expect(firstSamePath.fullPath === secondSamePath.fullPath).toBe(
      obs.samePathFullPathEqual as boolean,
    );
    expect(firstSamePath.toString() === secondSamePath.toString()).toBe(
      obs.samePathToStringEqual as boolean,
    );
    expect(rootFirst === rootSecond).toBe(obs.rootCallsStrictEqual as boolean);
    expect(rootFirst.root === rootFirst).toBe(obs.rootGetterOnRootStrictEqualSelf as boolean);
    expect(firstParent === secondParent).toBe(obs.repeatedParentGetterStrictEqual as boolean);
    expect(firstParent.toString() === secondParent.toString()).toBe(
      obs.repeatedParentToStringEqual as boolean,
    );
    expect(firstRoot === secondRoot).toBe(obs.repeatedRootGetterStrictEqual as boolean);
    expect(firstRoot.toString() === secondRoot.toString()).toBe(
      obs.repeatedRootToStringEqual as boolean,
    );
    expect(childFromParent.toString() === firstSamePath.toString()).toBe(
      obs.childJoinToStringMatchesDirect as boolean,
    );
    expect(childFromParent === firstSamePath).toBe(obs.childJoinStrictEqualDirect as boolean);
    expect(firstSamePath.storage === storage).toBe(obs.directPreservesStorageHandle as boolean);
    expect(firstParent.storage === storage).toBe(obs.parentPreservesStorageHandle as boolean);
    expect(firstRoot.storage === storage).toBe(obs.rootPreservesStorageHandle as boolean);
    expect(childFromParent.storage === storage).toBe(
      obs.childJoinPreservesStorageHandle as boolean,
    );
    expect(
      firstSamePath.bucket === handleBucket &&
        firstParent.bucket === handleBucket &&
        firstRoot.bucket === handleBucket &&
        childFromParent.bucket === handleBucket,
    ).toBe(obs.bucketPreservedAcrossChain as boolean);
  });
}
