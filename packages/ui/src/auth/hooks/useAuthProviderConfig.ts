import { useCallback, useEffect, useState } from 'react';
import type { Auth } from 'pyric/auth';
import { useAuthApi } from '../authApi.js';

/** One provider's current enablement, as the hook exposes it. */
export interface AuthProviderConfigEntry {
  providerId: string;
  enabled: boolean;
}

export interface UseAuthProviderConfigResult {
  /** Every provider this sandbox has an explicit enablement for. Unknown
   *  providers (never toggled) are simply absent — `isEnabled` treats an
   *  absent entry as enabled, matching the backend default. */
  config: AuthProviderConfigEntry[];
  isLoading: boolean;
  error: Error | undefined;
  /** Convenience lookup: `true` for a provider that's never been toggled. */
  isEnabled: (providerId: string) => boolean;
  /** Toggle a provider on/off. Sync (in-process) failures throw to the
   *  caller, same policy as `useAuthUsers`'s mutation callbacks; an ASYNC
   *  (worker-RPC) failure can't reach a sync caller, so it surfaces on the
   *  hook's `error` state instead — never an unhandled rejection. */
  setEnabled: (providerId: string, enabled: boolean) => void;
  /** Re-read manually. Rarely needed — every mutation (this hook's own
   *  `setEnabled`, another handle, the agent) already triggers the
   *  subscription re-list. */
  refresh: () => void;
}

/**
 * Live sign-in provider config view over a sandbox `Auth` handle:
 * `sandbox.getAuthProviderConfig` + `sandbox.subscribeAuthProviderConfig` +
 * `sandbox.setAuthProviderConfig`. Mirrors `useAuthUsers`'s shape exactly
 * (coarse "something changed, re-list" subscription; sync in-process,
 * tolerates a promise over the SharedWorker client).
 *
 * Sandbox-only: throws `failed-precondition` on a prod-backed handle (the
 * hook surfaces that via `error`, same as `useAuthUsers`).
 */
export function useAuthProviderConfig(auth: Auth): UseAuthProviderConfigResult {
  const {
    getAuthProviderConfig,
    setAuthProviderConfig: apiSetAuthProviderConfig,
    subscribeAuthProviderConfig,
  } = useAuthApi();

  const [config, setConfig] = useState<AuthProviderConfigEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(undefined);
    const apply = (c: AuthProviderConfigEntry[]) => {
      if (cancelled) return;
      setConfig(c);
      setIsLoading(false);
    };
    const applyErr = (e: unknown) => {
      if (cancelled) return;
      setConfig([]);
      setError(e instanceof Error ? e : new Error(String(e)));
      setIsLoading(false);
    };
    // `getAuthProviderConfig` is SYNC in-process, ASYNC (RPC) over the worker
    // — same thenable-tolerant branch `useAuthUsers` uses for `listUsers`.
    const relist = () => {
      try {
        const r = getAuthProviderConfig(auth) as
          | AuthProviderConfigEntry[]
          | Promise<AuthProviderConfigEntry[]>;
        if (r && typeof (r as Promise<AuthProviderConfigEntry[]>).then === 'function') {
          (r as Promise<AuthProviderConfigEntry[]>).then(apply).catch(applyErr);
        } else {
          apply(r as AuthProviderConfigEntry[]);
        }
      } catch (e) {
        applyErr(e);
      }
    };
    let unsub: (() => void) | undefined;
    try {
      relist();
      unsub = subscribeAuthProviderConfig(auth, relist);
    } catch (e) {
      applyErr(e);
    }
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [auth, getAuthProviderConfig, subscribeAuthProviderConfig]);

  const isEnabled = useCallback(
    (providerId: string) => config.find((c) => c.providerId === providerId)?.enabled ?? true,
    [config],
  );

  const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

  const setEnabled = useCallback(
    (providerId: string, enabled: boolean) => {
      // Over the worker this is an RPC promise — a fire-and-forget caller
      // would otherwise leave a rejection unhandled and the toggle silently
      // dead. Route async failures into the hook's error state; sync throws
      // still propagate (in-process policy, matching useAuthUsers).
      const r = apiSetAuthProviderConfig(auth, providerId, enabled) as void | Promise<void>;
      if (r && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).catch((e) => setError(toError(e)));
      }
    },
    [auth, apiSetAuthProviderConfig],
  );

  const refresh = useCallback(() => {
    try {
      const r = getAuthProviderConfig(auth) as
        | AuthProviderConfigEntry[]
        | Promise<AuthProviderConfigEntry[]>;
      if (r && typeof (r as Promise<AuthProviderConfigEntry[]>).then === 'function') {
        void (r as Promise<AuthProviderConfigEntry[]>)
          .then((c) => {
            setConfig(c);
            setError(undefined);
          })
          .catch((e) => setError(toError(e)));
      } else {
        setConfig(r as AuthProviderConfigEntry[]);
        setError(undefined);
      }
    } catch (e) {
      setError(toError(e));
    }
  }, [auth, getAuthProviderConfig]);

  return { config, isLoading, error, isEnabled, setEnabled, refresh };
}
