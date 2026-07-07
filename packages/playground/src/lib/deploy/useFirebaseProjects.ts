/**
 * List the user's Firebase projects via the Management API
 * (`firebase.googleapis.com/v1beta1/projects`), using the GIS-minted
 * `cloud-platform` access token from `useAccessToken`.
 *
 * Powers the Deploy tab's project dropdown. Fetches once on sign-in,
 * caches in component state, exposes `refresh()` for manual reload
 * (e.g. after the user creates a new project in the Console).
 *
 * Token source is `useAccessToken().resolveToken` — silently reissued
 * if expired. The hook tolerates the token being unavailable: when
 * the user isn't signed in, `projects` is empty and `error` stays
 * null until they sign in.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  fetchWebConfig,
  listProjects,
  listWebApps,
  type FirebaseProject,
  type FirebaseWebConfig,
} from '~/lib/firebase/management';

import { useAccessToken } from './useAccessToken';

/**
 * Fetch the default (first) web app's config for a project. Throws
 * `NoWebAppError` when the project has no web apps — caller surfaces
 * with a Console deeplink so the user can add one. Any other failure
 * propagates as the underlying `ManagementApiError`.
 */
export class NoWebAppError extends Error {
  constructor(public readonly projectId: string) {
    super(
      `Project '${projectId}' has no web app registered. Open Firebase Console → Project Settings → General → Your apps → Add app → Web.`,
    );
    this.name = 'NoWebAppError';
  }
}

export async function fetchDefaultWebConfig(
  token: string,
  projectId: string,
): Promise<FirebaseWebConfig> {
  const apps = await listWebApps(token, projectId);
  if (apps.length === 0) throw new NoWebAppError(projectId);
  return fetchWebConfig(token, projectId, apps[0]!.appId);
}

export interface UseFirebaseProjectsResult {
  projects: FirebaseProject[];
  /** True while the initial fetch is in flight. */
  loading: boolean;
  error: { code: string; message: string } | null;
  /** Force a re-fetch. Idempotent if already in flight. */
  refresh: () => Promise<void>;
}

export function useFirebaseProjects(): UseFirebaseProjectsResult {
  const { signedIn, resolveToken } = useAccessToken();
  const [projects, setProjects] = useState<FirebaseProject[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const load = useCallback(async () => {
    if (!signedIn) {
      setProjects([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const token = await resolveToken();
      const list = await listProjects(token);
      setProjects(list);
    } catch (e) {
      setError(classifyError(e));
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }, [signedIn, resolveToken]);

  // Fetch once on mount and whenever the sign-in state flips.
  useEffect(() => {
    void load();
  }, [load]);

  return { projects, loading, error, refresh: load };
}

function classifyError(e: unknown): { code: string; message: string } {
  if (e instanceof Error) {
    // ManagementApiError (from `lib/firebase/management.ts`) extends
    // Error and carries `status` + `body` fields, but the consumer
    // only needs a code + message string here.
    return { code: 'list-failed', message: e.message };
  }
  return { code: 'unknown', message: String(e) };
}
