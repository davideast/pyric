import { describe, expect, test } from 'bun:test';
import { getApps } from 'firebase/app';
import { probe as bucketUrlProbe } from '../../probes/storage/client-storage-getstorage-bucket-url.ts';
import {
  loadClientStorageProbes,
  selectClientStorageProbes,
} from '../../src/client-storage-probes.ts';
import { expectStagedUntilCaptured } from './staged-capture-assertions.ts';

const PROBE_ID = 'client-storage-getstorage-bucket-url';

describe('client-storage-getstorage-bucket-url staged probe (client-storage)', () => {
  test('registers on client-storage with pendingRowLink and stays skipped in unfiltered runs until captured', async () => {
    const loaded = await loadClientStorageProbes();
    const loadedIds = loaded.map((entry) => entry.id);
    expect(loadedIds).toContain(PROBE_ID);

    expect(bucketUrlProbe.rig).toBe('client-storage');
    expect(bucketUrlProbe.requires).toEqual([]);
    expect(bucketUrlProbe.pendingRowLink).toBe(true);
    expect(bucketUrlProbe.matrixRow).toBe('');
    expect(bucketUrlProbe.rowIds).toEqual([]);
    expect(bucketUrlProbe.description.length).toBeGreaterThan(20);

    const unfilteredIds = new Set(selectClientStorageProbes(loaded, []).map((entry) => entry.id));
    const explicitSelected = selectClientStorageProbes(loaded, ['--probe', PROBE_ID]);
    expect(explicitSelected.map((entry) => entry.id)).toEqual([PROBE_ID]);

    expectStagedUntilCaptured(PROBE_ID, {
      rig: 'client-storage',
      filterFlag: '--probe',
      filterValueFor: (name) => name,
      whenUncaptured(name) {
        expect(unfilteredIds.has(name)).toBe(false);
      },
      whenCaptured(name) {
        expect(unfilteredIds.has(name)).toBe(true);
      },
    });
  });

  test('executes deterministically with fetchCalls === 0 and records handle identity, bucket spellings, invalid URLs, and unconfigured ref behavior', async () => {
    const run1 = await bucketUrlProbe.observe();
    const run2 = await bucketUrlProbe.observe();
    expect(run1).toEqual(run2);
    expect(getApps()).toEqual([]);

    expect(run1.fetchCalls).toBe(0);

    const handles = run1.configuredHandles as Record<string, unknown>;
    expect(handles.appMatches).toBe(true);
    expect(handles.repeatDefaultSameHandle).toBe(true);
    expect(handles.repeatOwnGsSameHandle).toBe(true);
    expect(handles.repeatOtherGsSameHandle).toBe(true);
    expect(handles.defaultEqualsOwnGs).toBe(false);
    expect(handles.defaultEqualsOwnBare).toBe(false);
    expect(handles.otherGsEqualsOtherGsSlash).toBe(false);
    expect(handles.otherGsEqualsOtherBare).toBe(false);
    expect(handles.otherAppSameGsDistinctHandle).toBe(true);
    expect(handles.retryMutationOnOwnGsLeavesDefaultUnchanged).toBe(true);

    const spellings = run1.configuredBucketSpellings as Record<
      string,
      {
        getStorageOutcome: { threw: boolean };
        childRef: { bucket: string | null; toStringValue: string | null } | null;
      }
    >;
    expect(spellings.omitted?.childRef?.bucket).toBe('buckets-default');
    expect(spellings.omitted?.childRef?.toStringValue).toBe('gs://buckets-default/items/a.txt');
    expect(spellings.ownGs?.childRef?.bucket).toBe('buckets-default');
    expect(spellings.ownGsTrailingSlash?.childRef?.bucket).toBe('buckets-default');
    expect(spellings.ownBare?.childRef?.bucket).toBe('buckets-default');
    expect(spellings.otherGs?.childRef?.bucket).toBe('media-bucket');
    expect(spellings.otherGs?.childRef?.toStringValue).toBe('gs://media-bucket/items/a.txt');
    expect(spellings.otherGsTrailingSlash?.childRef?.bucket).toBe('media-bucket');
    expect(spellings.otherBare?.childRef?.bucket).toBe('media-bucket');
    expect(spellings.firebaseRootDownloadUrl?.childRef?.bucket).toBe('media-bucket');

    const invalid = run1.invalidBucketUrls as Record<
      string,
      {
        getStorageOutcome: {
          threw: boolean;
          threwSynchronously: boolean;
          code: string | null;
          isStorageError: boolean;
          isFirebaseError: boolean;
        };
      }
    >;
    for (const key of ['gsWithObjectPath', 'firebaseObjectDownloadUrl', 'cloudStorageObjectUrl']) {
      expect(invalid[key]?.getStorageOutcome.threw).toBe(true);
      expect(invalid[key]?.getStorageOutcome.threwSynchronously).toBe(true);
      expect(invalid[key]?.getStorageOutcome.code).toBe('storage/invalid-default-bucket');
      expect(invalid[key]?.getStorageOutcome.isStorageError).toBe(true);
      expect(invalid[key]?.getStorageOutcome.isFirebaseError).toBe(true);
    }

    const unconfigured = run1.unconfiguredStorageBucket as {
      repeatOmittedSameHandle: boolean;
      omitted: {
        getStorageOutcome: { threw: boolean };
        rootRef: { threw: boolean; threwSynchronously: boolean; code: string | null } | null;
        childRef: { threw: boolean; threwSynchronously: boolean; code: string | null } | null;
      };
      explicitGs: { childRef: { bucket: string | null; toStringValue: string | null } | null };
      explicitBare: { childRef: { bucket: string | null; toStringValue: string | null } | null };
      invalidGsWithObjectPath: { getStorageOutcome: { threw: boolean; code: string | null } };
    };
    expect(unconfigured.repeatOmittedSameHandle).toBe(true);
    expect(unconfigured.omitted.getStorageOutcome.threw).toBe(false);
    expect(unconfigured.omitted.rootRef?.threw).toBe(true);
    expect(unconfigured.omitted.rootRef?.threwSynchronously).toBe(true);
    expect(unconfigured.omitted.rootRef?.code).toBe('storage/no-default-bucket');
    expect(unconfigured.omitted.childRef?.threw).toBe(true);
    expect(unconfigured.omitted.childRef?.threwSynchronously).toBe(true);
    expect(unconfigured.omitted.childRef?.code).toBe('storage/no-default-bucket');
    expect(unconfigured.explicitGs.childRef?.bucket).toBe('media-bucket');
    expect(unconfigured.explicitBare.childRef?.bucket).toBe('media-bucket');
    expect(unconfigured.invalidGsWithObjectPath.getStorageOutcome.threw).toBe(true);
    expect(unconfigured.invalidGsWithObjectPath.getStorageOutcome.code).toBe(
      'storage/invalid-default-bucket',
    );
  });
});
