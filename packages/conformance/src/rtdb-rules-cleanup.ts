/**
 * Run-scoped data and Auth user cleanup contracts plus custom-token minting
 * shared by `run-rules-rtdb.ts` and `rtdb-rules-multi-instance.ts`.
 */
import {
  oracleServiceAccountEmail,
  signOracleJwt,
  type OracleServiceAccount,
} from './oracle-credential.ts';

/** The database operations run-data cleanup needs, narrowed for unit testing. */
export interface RunDataStore {
  /** Delete everything beneath the run-scoped namespace (admin, rules-bypassing). */
  deleteNamespace(auditKey: string): Promise<void>;
  /** Root-level keys via a shallow read -- the deletion's independent witness. */
  shallowRootKeys(): Promise<string[]>;
}

/**
 * DATA CLEANUP INVARIANT: deletes the run-scoped namespace and proves deletion
 * via an independent shallow root read.
 */
export async function verifyRunDataCleanup(store: RunDataStore, auditKey: string): Promise<void> {
  await store.deleteNamespace(auditKey);
  const rootKeys = await store.shallowRootKeys();
  if (rootKeys.includes(auditKey)) {
    throw new Error(
      `data cleanup NOT verified -- shallow read of the database root still lists the run-scoped namespace '${auditKey}' after deletion.`,
    );
  }
}

/** The run's user-cleanup operations, narrowed for unit testing. */
export interface RunUserStore {
  deleteUser(uid: string): Promise<void>;
  userExists(uid: string): Promise<boolean>;
}

/** Narrowed Admin Auth handle needed for run-created user cleanup. */
export interface AdminAuthUserClient {
  deleteUser(uid: string): Promise<void>;
  getUser(uid: string): Promise<unknown>;
}

/** Adapts `firebase-admin/auth` to `RunUserStore`, treating `auth/user-not-found` as absent. */
export function createAdminUserStore(adminAuth: AdminAuthUserClient): RunUserStore {
  return {
    async deleteUser(uid) {
      await adminAuth.deleteUser(uid);
    },
    async userExists(uid) {
      try {
        await adminAuth.getUser(uid);
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === 'auth/user-not-found') {
          return false;
        }
        throw error;
      }
    },
  };
}

/**
 * USER CLEANUP INVARIANT: deletes each Auth uid created during the run and
 * proves deletion via a follow-up lookup.
 */
export async function verifyRunUserCleanup(store: RunUserStore, uid: string): Promise<void> {
  if (await store.userExists(uid)) {
    await store.deleteUser(uid);
  }
  if (await store.userExists(uid)) {
    throw new Error(`user cleanup NOT verified: the run-created user '${uid}' still exists after deletion.`);
  }
}

export interface RunUserProps {
  uid: string;
  email?: string;
  emailVerified?: boolean;
}

export interface RunUserCreator {
  createUser(props: RunUserProps): Promise<void>;
}

/** Records `props.uid` before creation so a late failure still cleans up the user. */
export async function createRunUser(
  creator: RunUserCreator,
  runUids: Set<string>,
  props: RunUserProps,
): Promise<void> {
  runUids.add(props.uid);
  await creator.createUser(props);
}

/**
 * A Firebase custom token for `uid` with developer `claims`, signed as the
 * oracle service account. The issue time is set two minutes back so a local
 * clock somewhat ahead of Google's does not make `iat` lie in the future.
 */
export async function mintCustomToken(
  sa: OracleServiceAccount,
  uid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) - 120;
  const email = oracleServiceAccountEmail(sa);
  const payload: Record<string, unknown> = {
    iss: email,
    sub: email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat,
    exp: iat + 3600,
    uid,
  };
  if (Object.keys(claims).length > 0) {
    payload.claims = claims;
  }
  return signOracleJwt(sa, payload);
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function runBestEffortTeardown(
  logPrefix: string,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.warn(`${logPrefix} ${label} teardown warning: ${formatErrorMessage(error)}`);
  }
}
