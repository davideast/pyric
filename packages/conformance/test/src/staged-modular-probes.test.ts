import { describe, expect, it } from 'bun:test';
import { observationExceptions } from '../../exceptions/load.ts';
import { listProbeFiles } from '../../probes/load.ts';
import { allCompatibilityRows } from '../../registry/index.ts';
import { loadRigManifests } from '../../rigs/load.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../../rules-corpus/firestore/index.ts';
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
} from '../../rules-corpus/rtdb/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../../rules-corpus/storage/index.ts';
import { loadObservations, type Observation } from '../../src/ledger.ts';
import { loadModularProbes } from '../../src/sdk-probes.ts';
import {
  discoverUncapturedStagedTargets,
  loadPendingRowLinkObservations,
  loadStagedCaptureItems,
  resolveProbeRigFromSource,
} from '../../src/staged-captures.ts';
import { validateCompatibilityRegistry } from '../../src/validate-registry.ts';
import { surfaceDescriptors } from '../../surfaces/load.ts';
import {
  type AdminAuthCursorSubject,
  observeListUsersDeletedCursor,
  probe as adminAuthDeletedCursorProbe,
} from '../../probes/auth-admin/admin-auth-listusers-deleted-cursor.ts';
import {
  probeClientLimitValidation,
  probe as rtdbLimitInfinityProbe,
  scrubOracleRunPath,
} from '../../probes/rtdb-modular/rtdb-modular-query-limit-infinity.ts';
import { probe as rtdbLeafPromotionPriorityProbe } from '../../probes/rtdb-modular/rtdb-modular-leaf-promotion-priority.ts';

function makeSyntheticCapturedObservation(
  surfaceDir: string,
  name: string,
  rowIds: readonly string[] = [],
): Observation {
  return {
    file: `${name}.json`,
    surfaceDir,
    name,
    matrixRow: '',
    rowIds: [...rowIds],
    observedAt: '2026-11-17T00:00:00.000Z',
    fbSdkVersion: '12.19.0',
    behavior: { sample: true },
    raw: { fbSdkVersion: '12.19.0', rowIds: [...rowIds] },
  };
}

function createOrderedFakeAuth(
  initialUids: readonly string[] = [],
  orderFn: (uids: string[]) => string[] = (uids) => uids.sort(),
): { store: Set<string>; singlePageCalls: () => number; auth: AdminAuthCursorSubject } {
  const store = new Set<string>(initialUids);
  let singleCalls = 0;

  const ordered = (): string[] => orderFn([...store]);

  const auth: AdminAuthCursorSubject = {
    async createUser(uid: string): Promise<void> {
      store.add(uid);
    },
    async deleteUser(uid: string): Promise<void> {
      store.delete(uid);
    },
    async listUsers(
      maxResults: number,
      pageToken?: string,
    ): Promise<{ users: Array<{ uid: string }>; pageToken?: string }> {
      if (maxResults === 1) {
        singleCalls += 1;
      }
      const all = ordered();
      let startIdx = 0;
      if (pageToken !== undefined) {
        // Seek first remaining entry strictly after the cursor's sort key:
        const rankOf = new Map<string, number>();
        all.forEach((u, idx) => rankOf.set(u, idx));
        const exactIdx = rankOf.get(pageToken);
        if (exactIdx !== undefined) {
          startIdx = exactIdx + 1;
        } else {
          const withToken = orderFn([...store, pageToken]);
          const tokenPos = withToken.indexOf(pageToken);
          const nextUid = withToken[tokenPos + 1];
          if (nextUid === undefined) {
            return { users: [] };
          }
          startIdx = all.indexOf(nextUid);
        }
        if (startIdx < 0 || startIdx >= all.length) {
          return { users: [] };
        }
      }
      const slice = all.slice(startIdx, startIdx + maxResults);
      const last = slice[slice.length - 1];
      const hasMore = startIdx + maxResults < all.length;
      if (hasMore && last !== undefined) {
        return { users: slice.map((uid) => ({ uid })), pageToken: last };
      }
      return { users: slice.map((uid) => ({ uid })) };
    },
  };

  return { store, singlePageCalls: () => singleCalls, auth };
}

describe('staged modular probes (auth-admin and rtdb-modular)', () => {
  it('registers all three linked modular probes under their expected rigs, requirements, and rowIds', async () => {
    const adminAuthProbes = await loadModularProbes('admin-auth');
    expect(adminAuthProbes.map((p) => p.id)).toContain('admin-auth-listusers-deleted-cursor');
    expect(adminAuthDeletedCursorProbe.rig).toBe('admin-auth');
    expect(adminAuthDeletedCursorProbe.pendingRowLink).toBeUndefined();
    expect(adminAuthDeletedCursorProbe.rowIds).toEqual(['auth-admin#9']);
    expect(adminAuthDeletedCursorProbe.requires).toEqual(['admin-auth']);

    const sdkProbes = await loadModularProbes('sdk-probes');
    const sdkIds = sdkProbes.map((p) => p.id);
    expect(sdkIds).toContain('rtdb-modular-query-limit-infinity');
    expect(sdkIds).toContain('rtdb-modular-leaf-promotion-priority');

    expect(rtdbLimitInfinityProbe.rig).toBe('sdk-probes');
    expect(rtdbLimitInfinityProbe.pendingRowLink).toBeUndefined();
    expect(rtdbLimitInfinityProbe.rowIds).toEqual(['rtdb-modular#query-limit-infinity']);
    expect(rtdbLimitInfinityProbe.requires).toEqual(['web-config', 'dedicated-rtdb']);

    expect(rtdbLeafPromotionPriorityProbe.rig).toBe('sdk-probes');
    expect(rtdbLeafPromotionPriorityProbe.pendingRowLink).toBeUndefined();
    expect(rtdbLeafPromotionPriorityProbe.rowIds).toEqual([
      'rtdb-modular#leaf-promotion-priority',
      'rtdb-modular#M73',
    ]);
    expect(rtdbLeafPromotionPriorityProbe.requires).toEqual(['web-config', 'dedicated-rtdb']);
  });

  it('discovers uncaptured staged targets and validates cleanly across pre-capture, partial-capture, and linked states', async () => {
    const linkedModularNames = [
      'admin-auth-listusers-deleted-cursor',
      'rtdb-modular-query-limit-infinity',
      'rtdb-modular-leaf-promotion-priority',
    ] as const;

    const liveStagedItems = loadStagedCaptureItems();
    const liveStagedNames = liveStagedItems.map((item) => item.observationName);
    for (const linkedName of linkedModularNames) {
      expect(liveStagedNames).not.toContain(linkedName);
    }

    const currentObservations = loadObservations();
    const existingNames = new Set(currentObservations.map((obs) => obs.name));
    for (const linkedName of linkedModularNames) {
      expect(existingNames.has(linkedName)).toBe(true);
    }
    expect(discoverUncapturedStagedTargets()).toEqual(
      liveStagedItems.filter((item) => !existingNames.has(item.observationName)),
    );

    const syntheticStagedSpecs = [
      {
        rig: 'admin-auth',
        surfaceDir: 'auth-admin',
        name: 'admin-auth-synthetic-staged',
      },
      {
        rig: 'sdk-probes',
        surfaceDir: 'rtdb-modular',
        name: 'rtdb-modular-synthetic-staged-a',
      },
      {
        rig: 'sdk-probes',
        surfaceDir: 'rtdb-modular',
        name: 'rtdb-modular-synthetic-staged-b',
      },
    ] as const;
    const syntheticStagedItems = [
      ...liveStagedItems,
      ...syntheticStagedSpecs.map((spec) => ({
        rig: spec.rig,
        observationName: spec.name,
        filterFlag: '--probe' as const,
        filterValue: spec.name,
      })),
    ];

    const rigManifests = await loadRigManifests();
    const probeFiles = [
      ...listProbeFiles(),
      ...syntheticStagedSpecs.map((spec) => ({
        surfaceDir: spec.surfaceDir,
        name: spec.name,
        declaredRig: spec.rig,
      })),
    ];
    const pendingStems = new Set([
      ...loadPendingRowLinkObservations(),
      ...syntheticStagedSpecs.map((spec) => spec.name),
    ]);
    const rtdbScenarioIds = [
      ...ALL_RULES_RTDB_SCENARIOS.map((s) => s.id),
      ...ALL_RULES_RTDB_DEPLOY_SCENARIOS.map((s) => s.id),
    ];

    const validateWithObservations = (
      observations: Observation[],
      activeProbeFiles = listProbeFiles(),
      activePendingStems = loadPendingRowLinkObservations(),
    ): string[] =>
      validateCompatibilityRegistry({
        rows: allCompatibilityRows,
        descriptors: surfaceDescriptors,
        observations,
        observationExceptions,
        rigManifests,
        probeFiles: activeProbeFiles,
        rulesFirestoreScenarioIds: ALL_RULES_FIRESTORE_SCENARIOS.map((s) => s.id),
        rulesStorageScenarioIds: ALL_RULES_STORAGE_SCENARIOS.map((s) => s.id),
        rulesRtdbScenarioIds: rtdbScenarioIds,
        pendingRowLinkObservations: activePendingStems,
      });

    // Current linked filesystem state validates cleanly with default pendingRowLinkObservations
    expect(validateWithObservations(currentObservations)).toEqual([]);

    // Pre-capture state for synthetic staged probes
    const uncapturedBefore = discoverUncapturedStagedTargets({
      stagedItems: syntheticStagedItems,
      existingObservationNames: existingNames,
    }).map((item) => item.observationName);
    for (const spec of syntheticStagedSpecs) {
      expect(uncapturedBefore).toContain(spec.name);
    }
    expect(validateWithObservations(currentObservations, probeFiles, pendingStems)).toEqual([]);

    // Partial-capture state (admin-auth captured, sdk-probes still uncaptured)
    const afterAuthCaptureByName = new Map(currentObservations.map((obs) => [obs.name, obs]));
    afterAuthCaptureByName.set(
      'admin-auth-synthetic-staged',
      makeSyntheticCapturedObservation('auth-admin', 'admin-auth-synthetic-staged'),
    );
    const uncapturedAfterAuth = discoverUncapturedStagedTargets({
      stagedItems: syntheticStagedItems,
      existingObservationNames: new Set(afterAuthCaptureByName.keys()),
    }).map((item) => item.observationName);
    expect(uncapturedAfterAuth).not.toContain('admin-auth-synthetic-staged');
    expect(uncapturedAfterAuth).toContain('rtdb-modular-synthetic-staged-a');
    expect(uncapturedAfterAuth).toContain('rtdb-modular-synthetic-staged-b');
    expect(
      validateWithObservations([...afterAuthCaptureByName.values()], probeFiles, pendingStems),
    ).toEqual([]);

    // All-captured PR #2 state
    const afterAllCapturedByName = new Map(afterAuthCaptureByName);
    afterAllCapturedByName.set(
      'rtdb-modular-synthetic-staged-a',
      makeSyntheticCapturedObservation('rtdb-modular', 'rtdb-modular-synthetic-staged-a'),
    );
    afterAllCapturedByName.set(
      'rtdb-modular-synthetic-staged-b',
      makeSyntheticCapturedObservation('rtdb-modular', 'rtdb-modular-synthetic-staged-b'),
    );
    const uncapturedAfterAll = discoverUncapturedStagedTargets({
      stagedItems: syntheticStagedItems,
      existingObservationNames: new Set(afterAllCapturedByName.keys()),
    }).map((item) => item.observationName);
    for (const spec of syntheticStagedSpecs) {
      expect(uncapturedAfterAll).not.toContain(spec.name);
    }
    expect(
      validateWithObservations([...afterAllCapturedByName.values()], probeFiles, pendingStems),
    ).toEqual([]);
  });

  it('observeListUsersDeletedCursor captures progression cleanly on contiguous lexicographical order', async () => {
    const { store, auth } = createOrderedFakeAuth();
    const result = await observeListUsersDeletedCursor(auth, 'test-cursor');

    expect(result.deleteLastReturnedUser).toEqual({
      observedBaselineOrder: ['a1', 'a2', 'a3'],
      deletedRelativeUid: 'a1',
      threw: false,
      errorCode: null,
      tokenPresentAfterFirstUser: true,
      immediateNextRelativeUid: 'a2',
      remainingRelativeUidsVisited: ['a2', 'a3'],
      skippedAnySurvivingUser: false,
      duplicatedAnyUser: false,
    });
    expect(result.deleteNextBoundaryUser).toEqual({
      observedBaselineOrder: ['b1', 'b2', 'b3'],
      deletedRelativeUid: 'b2',
      threw: false,
      errorCode: null,
      tokenPresentBeforeDeletedUser: true,
      immediateNextRelativeUid: 'b3',
      remainingRelativeUidsVisited: ['b3'],
      skippedSurvivingTailUser: false,
      duplicatedAnyUser: false,
    });
    expect(store.size).toBe(0);
  });

  it('observeListUsersDeletedCursor handles 450 pre-existing users via coarse scan, non-ASCII live order, and interleaved foreign users', async () => {
    const preExisting: string[] = [];
    for (let i = 0; i < 450; i += 1) {
      preExisting.push(`000-foreign-${String(i).padStart(4, '0')}`);
    }
    preExisting.push('mid-foreign-between-a', 'mid-foreign-between-b', 'zzz-foreign-tail');

    // Custom non-lexicographical sort that reverses group suffixes (a3 -> mid-foreign -> a2 -> a1)
    // and interleaves foreign users right between our probe users!
    const customRank = (uid: string): string => {
      if (uid.startsWith('000-foreign-')) return `0:${uid}`;
      if (uid === 'test-cursor-a3') return '1:01';
      if (uid === 'mid-foreign-between-a') return '1:02';
      if (uid === 'test-cursor-a2') return '1:03';
      if (uid === 'test-cursor-a1') return '1:04';
      if (uid === 'test-cursor-b3') return '2:01';
      if (uid === 'test-cursor-b1') return '2:02';
      if (uid === 'mid-foreign-between-b') return '2:03';
      if (uid === 'test-cursor-b2') return '2:04';
      return `9:${uid}`;
    };

    const { store, singlePageCalls, auth } = createOrderedFakeAuth(preExisting, (uids) =>
      uids.sort((x, y) => customRank(x).localeCompare(customRank(y))),
    );

    const result = await observeListUsersDeletedCursor(auth, 'test-cursor');

    // Coarse scan skipped first 400 foreign users without walking all 450 twice 1-by-1:
    expect(singlePageCalls()).toBeLessThan(350);

    expect(result.deleteLastReturnedUser).toEqual({
      observedBaselineOrder: ['a3', 'a2', 'a1'],
      deletedRelativeUid: 'a3',
      threw: false,
      errorCode: null,
      tokenPresentAfterFirstUser: true,
      immediateNextRelativeUid: '<foreign>',
      remainingRelativeUidsVisited: ['a2', 'a1'],
      skippedAnySurvivingUser: false,
      duplicatedAnyUser: false,
    });
    expect(result.deleteNextBoundaryUser).toEqual({
      observedBaselineOrder: ['b3', 'b1', 'b2'],
      deletedRelativeUid: 'b1',
      threw: false,
      errorCode: null,
      tokenPresentBeforeDeletedUser: true,
      immediateNextRelativeUid: '<foreign>',
      remainingRelativeUidsVisited: ['b2'],
      skippedSurvivingTailUser: false,
      duplicatedAnyUser: false,
    });
    // Pre-existing foreign users untouched; all probe users cleaned up:
    expect(store.size).toBe(preExisting.length);
  });

  it('observeListUsersDeletedCursor fails closed when target user is missing or lacks a trailing pageToken', async () => {
    const brokenMissingAuth: AdminAuthCursorSubject = {
      async createUser(): Promise<void> {},
      async deleteUser(): Promise<void> {},
      async listUsers(): Promise<{ users: Array<{ uid: string }>; pageToken?: string }> {
        return { users: [{ uid: 'unrelated-user' }] };
      },
    };
    await expect(observeListUsersDeletedCursor(brokenMissingAuth, 'test-cursor')).rejects.toThrow(
      /without finding created probe users/,
    );

    let stepOneCalls = 0;
    const brokenMissingTokenAuth: AdminAuthCursorSubject = {
      async createUser(): Promise<void> {},
      async deleteUser(): Promise<void> {},
      async listUsers(
        maxResults: number,
      ): Promise<{ users: Array<{ uid: string }>; pageToken?: string }> {
        if (maxResults > 1) {
          return {
            users: [
              { uid: 'test-cursor-a1' },
              { uid: 'test-cursor-a2' },
              { uid: 'test-cursor-a3' },
            ],
          };
        }
        stepOneCalls += 1;
        if (stepOneCalls === 1) return { users: [{ uid: 'test-cursor-a1' }], pageToken: 't1' };
        if (stepOneCalls === 2) return { users: [{ uid: 'test-cursor-a2' }], pageToken: 't2' };
        if (stepOneCalls === 3) return { users: [{ uid: 'test-cursor-a3' }] };
        // On advanceUntilTargetUid, return target user WITHOUT pageToken:
        return { users: [{ uid: 'test-cursor-a1' }] };
      },
    };
    await expect(
      observeListUsersDeletedCursor(brokenMissingTokenAuth, 'test-cursor'),
    ).rejects.toThrow(/had no trailing pageToken/);
  });

  it('probeClientLimitValidation records upstream firebase/database client acceptance of Infinity vs finite bounds', async () => {
    const validation = await probeClientLimitValidation();
    expect(validation.limitToFirstInfinity.threw).toBe(false);
    expect(validation.limitToLastInfinity.threw).toBe(false);
    expect(validation.limitToFirstZero.threw).toBe(true);
    expect(validation.limitToFirstNegativeInfinity.threw).toBe(true);
    expect(validation.limitToFirstNaN.threw).toBe(true);
  });

  it('scrubOracleRunPath replaces dynamic rtdb_<runId> segments with <runId> for idempotent re-captures', () => {
    expect(
      scrubOracleRunPath(
        "permission_denied at /pyric_oracle/rtdb_mwkln89r_1pn2jn/firstAtMostTwo/items: Client doesn't have permission to access the desired data.",
      ),
    ).toBe(
      "permission_denied at /pyric_oracle/<runId>/firstAtMostTwo/items: Client doesn't have permission to access the desired data.",
    );
    expect(scrubOracleRunPath('Permission denied')).toBe('Permission denied');
  });

  it('resolves explicit rig declarations on modular probe files and enforces pendingPrefixes promotion on PR #3', async () => {
    expect(
      resolveProbeRigFromSource(
        "export const probe = { rig: 'sdk-probes', pendingRowLink: true, rowIds: [] };",
        'rtdb-modular-query-limit-infinity',
      ),
    ).toBe('sdk-probes');
    expect(
      resolveProbeRigFromSource(
        "export const probe = { rig: 'admin-auth', pendingRowLink: true, rowIds: [] };",
        'admin-auth-listusers-deleted-cursor',
      ),
    ).toBe('admin-auth');
    expect(
      resolveProbeRigFromSource(
        'export const probe = { pendingRowLink: true, rowIds: [] };',
        'client-storage-new-probe',
      ),
    ).toBe('client-storage');

    const rigManifests = await loadRigManifests();
    const adminAuthRig = rigManifests.find((m) => m.id === 'admin-auth');
    expect(adminAuthRig).toBeDefined();
    expect(adminAuthRig?.observationPrefixes).toContain('admin-auth-');
    expect(adminAuthRig?.pendingPrefixes).toEqual([]);

    const unpromotedRigManifests = rigManifests.map((manifest) => {
      if (manifest.id === 'admin-auth') {
        return {
          ...manifest,
          observationPrefixes: [],
          pendingPrefixes: ['admin-auth-'],
        };
      }
      return manifest;
    });
    const baseObservationsWithoutAdminAuth = loadObservations().filter(
      (obs) => !obs.name.startsWith('admin-auth-'),
    );
    const baseRowsWithoutAdminAuthObs = allCompatibilityRows.map((row) => {
      if (!row.oracleObservations.some((obs) => obs.startsWith('admin-auth-'))) {
        return row;
      }
      const remainingObservations = row.oracleObservations.filter(
        (obs) => !obs.startsWith('admin-auth-'),
      );
      if (remainingObservations.length > 0) {
        return {
          ...row,
          oracleObservations: remainingObservations,
        };
      }
      return {
        ...row,
        automation: 'unit-backed' as const,
        oracleObservations: [],
      };
    });

    const stagedAdminAuthObs = makeSyntheticCapturedObservation(
      'auth-admin',
      'admin-auth-listusers-deleted-cursor',
    );
    const pr2Problems = validateCompatibilityRegistry({
      rows: baseRowsWithoutAdminAuthObs,
      descriptors: surfaceDescriptors,
      observations: [...baseObservationsWithoutAdminAuth, stagedAdminAuthObs],
      observationExceptions,
      rigManifests: unpromotedRigManifests,
      pendingRowLinkObservations: new Set([
        ...loadPendingRowLinkObservations(),
        'admin-auth-listusers-deleted-cursor',
      ]),
    });
    expect(pr2Problems).toEqual([]);

    const authAdminRow = baseRowsWithoutAdminAuthObs.find((r) => r.surface === 'auth-admin');
    let authRowId = 'auth-admin#1';
    if (authAdminRow !== undefined) {
      authRowId = authAdminRow.id;
    }
    const linkedAdminAuthObs = makeSyntheticCapturedObservation(
      'auth-admin',
      'admin-auth-listusers-deleted-cursor',
      [authRowId],
    );
    const pr3Rows = baseRowsWithoutAdminAuthObs.map((row) => {
      if (row.id !== authRowId) return row;
      return {
        ...row,
        oracleObservations: [...row.oracleObservations, 'admin-auth-listusers-deleted-cursor'],
      };
    });
    const pr3ProblemsWithoutPromotion = validateCompatibilityRegistry({
      rows: pr3Rows,
      descriptors: surfaceDescriptors,
      observations: [...baseObservationsWithoutAdminAuth, linkedAdminAuthObs],
      observationExceptions,
      rigManifests: unpromotedRigManifests,
      pendingRowLinkObservations: loadPendingRowLinkObservations(),
    });
    expect(
      pr3ProblemsWithoutPromotion.some((p) =>
        p.includes("pending prefix 'admin-auth-' now matches a captured observation"),
      ),
    ).toBe(true);
  });
});
