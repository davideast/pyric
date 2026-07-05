import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Auth,
  AuthUserRecord,
  CreateUserRequest,
  UpdateUserRequest,
} from 'pyric/auth';
import { useAuthApi } from '../authApi.js';

export interface UseAuthUsersResult {
  /** Users matching {@link filter} (everyone when the filter is empty). */
  users: AuthUserRecord[];
  /** Unfiltered count: lets a list distinguish "no users at all" from
   *  "no results for this filter". */
  totalCount: number;
  isLoading: boolean;
  error: Error | undefined;
  /** Case-insensitive substring match over uid, email, display name and
   *  phone number (the emulator UI's search semantics). */
  filter: string;
  setFilter: (filter: string) => void;
  createUser: (request: CreateUserRequest) => AuthUserRecord;
  updateUser: (uid: string, update: UpdateUserRequest) => AuthUserRecord;
  deleteUser: (uid: string) => void;
  clearUsers: () => void;
  /** Re-list manually. Rarely needed, every mutation (including ones made
   *  by the agent or the running app) already triggers `subscribeUsers`. */
  refresh: () => void;
}

function matches(user: AuthUserRecord, needle: string): boolean {
  return [user.uid, user.email, user.displayName, user.phoneNumber].some(
    (v) => v != null && v.toLowerCase().includes(needle),
  );
}

/**
 * Live user-admin view over a sandbox `Auth` handle:
 * `sandbox.listUsers` + `sandbox.subscribeUsers` + CRUD actions.
 *
 * The subscription is coarse ("something changed"): any user-DB
 * mutation (from these actions, the running app's sign-ups, the
 * agent's seeding) triggers a re-list, so the view stays live without
 * per-row bookkeeping. Filtering is client-side (the sandbox is
 * in-process; there is no server to push the query to).
 *
 * Mutation errors (e.g. `auth/uid-already-exists`) throw to the caller:
 * handle them at the call site like the firestore hooks' `createDocument`.
 * Sandbox-only: throws `failed-precondition` on a prod-backed handle (the
 * hook surfaces that via `error`).
 */
export function useAuthUsers(auth: Auth): UseAuthUsersResult {
  // The sandbox auth ops, injected: in-process `pyric/auth` by default, or the
  // SharedWorker client bundle when a consumer (Pyric Studio served mode) wraps
  // the tree in an `AuthApiProvider`.
  const {
    listUsers,
    subscribeUsers,
    createUser: apiCreateUser,
    updateUser: apiUpdateUser,
    deleteUser: apiDeleteUser,
    clearUsers: apiClearUsers,
  } = useAuthApi();
  const [all, setAll] = useState<AuthUserRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(undefined);
    const applyUsers = (u: AuthUserRecord[]) => {
      if (cancelled) return;
      setAll(u);
      setIsLoading(false);
    };
    const applyErr = (e: unknown) => {
      if (cancelled) return;
      setAll([]);
      setError(e instanceof Error ? e : new Error(String(e)));
      setIsLoading(false);
    };
    // `listUsers` is SYNC in-process (apply immediately, preserving the sync
    // contract existing consumers + tests rely on) but ASYNC over the worker (an
    // RPC), so branch on a thenable. The subscription is coarse: re-list on any
    // change.
    const relist = () => {
      try {
        const r = listUsers(auth) as AuthUserRecord[] | Promise<AuthUserRecord[]>;
        if (r && typeof (r as Promise<AuthUserRecord[]>).then === 'function') {
          (r as Promise<AuthUserRecord[]>).then(applyUsers).catch(applyErr);
        } else {
          applyUsers(r as AuthUserRecord[]);
        }
      } catch (e) {
        applyErr(e);
      }
    };
    let unsub: (() => void) | undefined;
    try {
      relist();
      unsub = subscribeUsers(auth, relist);
    } catch (e) {
      applyErr(e);
    }
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [auth, listUsers, subscribeUsers]);

  const users = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((u) => matches(u, needle));
  }, [all, filter]);

  const createUser = useCallback(
    (request: CreateUserRequest) => apiCreateUser(auth, request),
    [auth, apiCreateUser],
  );
  const updateUser = useCallback(
    (uid: string, update: UpdateUserRequest) => apiUpdateUser(auth, uid, update),
    [auth, apiUpdateUser],
  );
  const deleteUser = useCallback(
    (uid: string) => apiDeleteUser(auth, uid),
    [auth, apiDeleteUser],
  );
  const clearUsers = useCallback(() => apiClearUsers(auth), [auth, apiClearUsers]);
  const refresh = useCallback(() => {
    const r = listUsers(auth) as AuthUserRecord[] | Promise<AuthUserRecord[]>;
    if (r && typeof (r as Promise<AuthUserRecord[]>).then === 'function') {
      void (r as Promise<AuthUserRecord[]>).then((u) => setAll(u)).catch(() => {});
    } else {
      setAll(r as AuthUserRecord[]);
    }
  }, [auth, listUsers]);

  return {
    users,
    totalCount: all.length,
    isLoading,
    error,
    filter,
    setFilter,
    createUser,
    updateUser,
    deleteUser,
    clearUsers,
    refresh,
  };
}
