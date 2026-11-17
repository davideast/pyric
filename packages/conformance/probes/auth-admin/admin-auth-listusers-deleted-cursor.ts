import type { Probe } from '../../rigs/types.ts';
import { withAdminAuthProbeSession } from '../../src/sdk-probe-runtime.ts';

export interface AdminAuthCursorSubject {
  createUser(uid: string): Promise<void>;
  deleteUser(uid: string): Promise<void>;
  listUsers(
    maxResults: number,
    pageToken?: string,
  ): Promise<{ users: ReadonlyArray<{ uid: string }>; pageToken?: string }>;
}

export interface CursorDeletionCaseOutcome {
  observedBaselineOrder: [string, string, string];
  deletedRelativeUid: string;
  threw: boolean;
  errorCode: string | null;
  tokenPresentAfterFirstUser?: boolean;
  tokenPresentBeforeDeletedUser?: boolean;
  immediateNextRelativeUid: string | null;
  remainingRelativeUidsVisited: string[];
  skippedAnySurvivingUser?: boolean;
  skippedSurvivingTailUser?: boolean;
  duplicatedAnyUser: boolean;
}

const COARSE_SCAN_PAGE_SIZE = 200;
const MAX_COARSE_SCAN_PAGES = 100;
const MAX_SINGLE_STEP_PAGES = 600;

function relativeSuffix(uid: string, prefix: string): string | null {
  const marker = `${prefix}-`;
  if (!uid.startsWith(marker)) {
    return null;
  }
  return uid.slice(marker.length);
}

function extractErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    return code;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return null;
}

async function findCoarseCursorBeforeGroup(options: {
  auth: AdminAuthCursorSubject;
  groupUids: ReadonlySet<string>;
}): Promise<string | undefined> {
  let cursor: string | undefined;
  for (let step = 0; step < MAX_COARSE_SCAN_PAGES; step += 1) {
    const prevCursor = cursor;
    const page = await options.auth.listUsers(COARSE_SCAN_PAGE_SIZE, cursor);
    if (page.users.some((u) => options.groupUids.has(u.uid))) {
      return prevCursor;
    }
    if (!page.pageToken) {
      throw new Error(
        `Coarse listUsers(${COARSE_SCAN_PAGE_SIZE}) scan reached end of project without finding created probe users`,
      );
    }
    cursor = page.pageToken;
  }
  throw new Error(
    `Exceeded ${MAX_COARSE_SCAN_PAGES} coarse listUsers(${COARSE_SCAN_PAGE_SIZE}) pages searching for probe group`,
  );
}

async function observeBaselineGroupOrder(options: {
  auth: AdminAuthCursorSubject;
  startCursor: string | undefined;
  uidPrefix: string;
  expectedRels: ReadonlySet<string>;
}): Promise<[string, string, string]> {
  const observed: string[] = [];
  let cursor = options.startCursor;
  for (let step = 0; step < MAX_SINGLE_STEP_PAGES; step += 1) {
    const page = await options.auth.listUsers(1, cursor);
    const first = page.users[0];
    if (first) {
      const rel = relativeSuffix(first.uid, options.uidPrefix);
      if (rel !== null && options.expectedRels.has(rel) && !observed.includes(rel)) {
        observed.push(rel);
        if (observed.length === 3) {
          const [r0, r1, r2] = observed;
          if (r0 !== undefined && r1 !== undefined && r2 !== undefined) {
            return [r0, r1, r2];
          }
        }
      }
    }
    if (!page.pageToken) {
      throw new Error(
        `Baseline listUsers(1) walk ended before observing all 3 created probe users (saw [${observed.join(', ')}])`,
      );
    }
    cursor = page.pageToken;
  }
  throw new Error(
    `Exceeded ${MAX_SINGLE_STEP_PAGES} listUsers(1) pages during baseline order observation`,
  );
}

async function advanceUntilTargetUid(options: {
  auth: AdminAuthCursorSubject;
  targetUid: string;
  startCursor: string | undefined;
}): Promise<string> {
  let cursor = options.startCursor;
  for (let step = 0; step < MAX_SINGLE_STEP_PAGES; step += 1) {
    const page = await options.auth.listUsers(1, cursor);
    const first = page.users[0];
    if (first && first.uid === options.targetUid) {
      if (page.pageToken === undefined || page.pageToken === '') {
        throw new Error(
          `Target user '${options.targetUid}' had no trailing pageToken in listUsers(1)`,
        );
      }
      return page.pageToken;
    }
    if (!page.pageToken) {
      throw new Error(
        `Reached end of listUsers(1) without finding target user '${options.targetUid}'`,
      );
    }
    cursor = page.pageToken;
  }
  throw new Error(
    `Exceeded ${MAX_SINGLE_STEP_PAGES} pages searching for '${options.targetUid}' in listUsers(1)`,
  );
}

async function collectSurvivingGroupUids(options: {
  auth: AdminAuthCursorSubject;
  startPageToken: string;
  uidPrefix: string;
  allGroupRels: ReadonlySet<string>;
  expectedSurvivingRels: ReadonlySet<string>;
}): Promise<{ immediateNextRelativeUid: string | null; visited: string[] }> {
  const visited: string[] = [];
  const seenSurviving = new Set<string>();
  let immediateNextRelativeUid: string | null = null;
  let cursor: string | undefined = options.startPageToken;

  for (let step = 0; step < MAX_SINGLE_STEP_PAGES && cursor !== undefined; step += 1) {
    const page = await options.auth.listUsers(1, cursor);
    const first = page.users[0];
    if (first) {
      const rel = relativeSuffix(first.uid, options.uidPrefix);
      if (step === 0) {
        immediateNextRelativeUid = rel ?? '<foreign>';
      }
      if (rel !== null && options.allGroupRels.has(rel)) {
        visited.push(rel);
        if (options.expectedSurvivingRels.has(rel)) {
          seenSurviving.add(rel);
          if (seenSurviving.size === options.expectedSurvivingRels.size) {
            return { immediateNextRelativeUid, visited };
          }
        }
      }
    }
    cursor = page.pageToken;
  }

  if (cursor !== undefined) {
    throw new Error(
      `Exceeded ${MAX_SINGLE_STEP_PAGES} listUsers(1) pages collecting surviving probe users (saw [${visited.join(', ')}])`,
    );
  }
  return { immediateNextRelativeUid, visited };
}

async function runCursorDeletionSubcase(options: {
  auth: AdminAuthCursorSubject;
  uidPrefix: string;
  groupRels: readonly [string, string, string];
  mode: 'delete-returned' | 'delete-next-boundary';
  created: Set<string>;
}): Promise<CursorDeletionCaseOutcome> {
  const allGroupRels = new Set<string>(options.groupRels);
  const groupUids = new Set<string>();
  for (const rel of options.groupRels) {
    const uid = `${options.uidPrefix}-${rel}`;
    options.created.add(uid);
    groupUids.add(uid);
    await options.auth.createUser(uid);
  }

  const startCursor = await findCoarseCursorBeforeGroup({
    auth: options.auth,
    groupUids,
  });
  const observedOrder = await observeBaselineGroupOrder({
    auth: options.auth,
    startCursor,
    uidPrefix: options.uidPrefix,
    expectedRels: allGroupRels,
  });
  const [firstRel, secondRel, thirdRel] = observedOrder;
  const firstUid = `${options.uidPrefix}-${firstRel}`;
  const mintedPageToken = await advanceUntilTargetUid({
    auth: options.auth,
    targetUid: firstUid,
    startCursor,
  });

  let deletedRelativeUid = firstRel;
  let expectedSurvivingRels = new Set<string>([secondRel, thirdRel]);
  if (options.mode === 'delete-next-boundary') {
    deletedRelativeUid = secondRel;
    expectedSurvivingRels = new Set<string>([thirdRel]);
  }

  const uidToDelete = `${options.uidPrefix}-${deletedRelativeUid}`;
  await options.auth.deleteUser(uidToDelete);
  options.created.delete(uidToDelete);

  try {
    const walked = await collectSurvivingGroupUids({
      auth: options.auth,
      startPageToken: mintedPageToken,
      uidPrefix: options.uidPrefix,
      allGroupRels,
      expectedSurvivingRels,
    });
    const uniqueVisited = new Set(walked.visited);
    let missingSurviving = false;
    for (const expectedRel of expectedSurvivingRels) {
      if (!walked.visited.includes(expectedRel)) {
        missingSurviving = true;
      }
    }
    const base: CursorDeletionCaseOutcome = {
      observedBaselineOrder: observedOrder,
      deletedRelativeUid,
      threw: false,
      errorCode: null,
      immediateNextRelativeUid: walked.immediateNextRelativeUid,
      remainingRelativeUidsVisited: walked.visited,
      duplicatedAnyUser: uniqueVisited.size !== walked.visited.length,
    };
    if (options.mode === 'delete-returned') {
      base.tokenPresentAfterFirstUser = true;
      base.skippedAnySurvivingUser = missingSurviving;
    } else {
      base.tokenPresentBeforeDeletedUser = true;
      base.skippedSurvivingTailUser = missingSurviving;
    }
    return base;
  } catch (err) {
    const base: CursorDeletionCaseOutcome = {
      observedBaselineOrder: observedOrder,
      deletedRelativeUid,
      threw: true,
      errorCode: extractErrorCode(err),
      immediateNextRelativeUid: null,
      remainingRelativeUidsVisited: [],
      duplicatedAnyUser: false,
    };
    if (options.mode === 'delete-returned') {
      base.tokenPresentAfterFirstUser = true;
      base.skippedAnySurvivingUser = true;
    } else {
      base.tokenPresentBeforeDeletedUser = true;
      base.skippedSurvivingTailUser = true;
    }
    return base;
  }
}

export async function observeListUsersDeletedCursor(
  auth: AdminAuthCursorSubject,
  uidPrefix: string,
): Promise<{
  deleteLastReturnedUser: CursorDeletionCaseOutcome;
  deleteNextBoundaryUser: CursorDeletionCaseOutcome;
}> {
  const created = new Set<string>();
  try {
    const deleteLastReturnedUser = await runCursorDeletionSubcase({
      auth,
      uidPrefix,
      groupRels: ['a1', 'a2', 'a3'],
      mode: 'delete-returned',
      created,
    });
    const deleteNextBoundaryUser = await runCursorDeletionSubcase({
      auth,
      uidPrefix,
      groupRels: ['b1', 'b2', 'b3'],
      mode: 'delete-next-boundary',
      created,
    });
    return { deleteLastReturnedUser, deleteNextBoundaryUser };
  } finally {
    for (const uid of created) {
      await auth.deleteUser(uid).catch(() => undefined);
    }
  }
}

export const probe: Probe = {
  rig: 'admin-auth',
  requires: ['admin-auth'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/auth listUsers(1, pageToken) cursor progression when either the last-returned user or the next boundary user at pageToken is deleted between pages.',
  async observe() {
    return withAdminAuthProbeSession(async ({ adminAuth, uidPrefix, createProbeUser }) => {
      const subject: AdminAuthCursorSubject = {
        async createUser(uid: string): Promise<void> {
          await createProbeUser({ uid });
        },
        async deleteUser(uid: string): Promise<void> {
          await adminAuth.deleteUser(uid);
        },
        async listUsers(maxResults: number, pageToken?: string) {
          return adminAuth.listUsers(maxResults, pageToken);
        },
      };
      return observeListUsersDeletedCursor(subject, uidPrefix);
    });
  },
};
