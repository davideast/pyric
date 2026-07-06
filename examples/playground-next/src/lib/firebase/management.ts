/**
 * Firebase Management API client — list a signed-in user's projects,
 * fetch their web configs, optionally provision web apps and
 * Firestore databases.
 *
 * Plain `fetch` over HTTPS with `Authorization: Bearer <accessToken>`.
 * Token comes from `google-signin.ts` (Layer 1 OAuth, `firebase`
 * scope). All endpoints under `firebase.googleapis.com/v1beta1` plus
 * the Firestore Admin endpoints under `firestore.googleapis.com/v1`
 * for optional database creation.
 *
 * The functions here are pure HTTP — no UI, no state. Slice 4's save
 * flow composes them through `ensure*` idempotent wrappers (which
 * cache + short-circuit on second call so a save burst doesn't hit
 * the Management API repeatedly).
 */

const FIREBASE_API = 'https://firebase.googleapis.com/v1beta1';
const FIRESTORE_API = 'https://firestore.googleapis.com/v1';

export interface FirebaseProject {
  /** Resource name, `projects/{projectId}`. */
  name: string;
  projectId: string;
  displayName?: string;
  projectNumber?: string;
  state?: 'ACTIVE' | 'DELETED';
}

export interface FirebaseWebApp {
  /** Resource name, `projects/{projectId}/webApps/{appId}`. */
  name: string;
  appId: string;
  displayName?: string;
  /** Stable namespace string; useful for ID lookups. */
  namespace?: string;
}

/**
 * The web config object that gets passed to
 * `firebase/app#initializeApp`. Same shape Firebase's docs show as
 * "your project's config object."
 */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
}

/**
 * Wrapper for any Management-API failure. `status` is the HTTP code;
 * `body` is the raw response body for diagnostics.
 */
export class ManagementApiError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Firebase Management API ${endpoint} failed: ${status} ${body || '(empty body)'}`);
    this.name = 'ManagementApiError';
  }
}

async function get<T>(accessToken: string, url: string): Promise<T> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new ManagementApiError(url, r.status, await r.text().catch(() => ''));
  return r.json() as Promise<T>;
}

async function post<T>(accessToken: string, url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new ManagementApiError(url, r.status, await r.text().catch(() => ''));
  return r.json() as Promise<T>;
}

/**
 * List every Firebase project the signed-in user has access to.
 * Auto-paginates through `nextPageToken` so the caller gets the full
 * list in one call. Sorted client-side by `displayName ?? projectId`
 * so the playground's project picker shows a stable order.
 */
export async function listProjects(accessToken: string): Promise<FirebaseProject[]> {
  const projects: FirebaseProject[] = [];
  let pageToken: string | undefined;
  do {
    const url = `${FIREBASE_API}/projects?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const resp = await get<{ results?: FirebaseProject[]; nextPageToken?: string }>(accessToken, url);
    if (resp.results) projects.push(...resp.results);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return projects.sort((a, b) => {
    const an = a.displayName ?? a.projectId;
    const bn = b.displayName ?? b.projectId;
    return an.localeCompare(bn);
  });
}

/**
 * List web apps registered under a Firebase project. Empty list
 * means the project has no web app — the playground creates one
 * via {@link createWebApp} on first save.
 */
export async function listWebApps(accessToken: string, projectId: string): Promise<FirebaseWebApp[]> {
  const url = `${FIREBASE_API}/projects/${encodeURIComponent(projectId)}/webApps`;
  const resp = await get<{ apps?: FirebaseWebApp[] }>(accessToken, url);
  return resp.apps ?? [];
}

/**
 * Create a web app in the given project. Returns the new web app's
 * `appId` (after polling the long-running operation to completion;
 * web app creation is fast — typically <2s).
 *
 * The displayName is what shows in the Firebase Console; the
 * playground uses 'Pyric Playground'.
 */
export async function createWebApp(
  accessToken: string,
  projectId: string,
  displayName: string,
): Promise<FirebaseWebApp> {
  const url = `${FIREBASE_API}/projects/${encodeURIComponent(projectId)}/webApps`;
  // Web app creation is a long-running operation that returns an
  // operation resource. We poll until it completes.
  const op = await post<{ name: string; done?: boolean; response?: FirebaseWebApp }>(
    accessToken,
    url,
    { displayName },
  );
  return waitForOperation<FirebaseWebApp>(accessToken, op);
}

/**
 * Fetch the `firebase/app#initializeApp` config for a web app. This
 * is the JSON the user pastes into their app — `apiKey`, `authDomain`,
 * etc. Distributable publicly; treat it like any Firebase config.
 */
export async function fetchWebConfig(
  accessToken: string,
  projectId: string,
  appId: string,
): Promise<FirebaseWebConfig> {
  const url = `${FIREBASE_API}/projects/${encodeURIComponent(projectId)}/webApps/${encodeURIComponent(appId)}/config`;
  return get<FirebaseWebConfig>(accessToken, url);
}

/**
 * Check if a Firestore database exists in the project. Returns the
 * default database resource if present, `null` otherwise. Slice 5
 * uses this to decide whether to provision a Firestore on first
 * save; slice 4's flow short-circuits if no database exists with a
 * "set up Firestore in the Console" toast.
 */
export async function getFirestoreDatabase(
  accessToken: string,
  projectId: string,
): Promise<{ name: string; locationId: string; type?: string } | null> {
  const url = `${FIRESTORE_API}/projects/${encodeURIComponent(projectId)}/databases/(default)`;
  try {
    return await get(accessToken, url);
  } catch (e) {
    if (e instanceof ManagementApiError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Provision a `(default)` Firestore database in the project. Used by
 * slice 5's optional flow when the user picks a project that has no
 * Firestore yet. `locationId` is e.g. `'nam5'` (multi-region US) or
 * `'us-central1'` (regional).
 */
export async function createFirestoreDatabase(
  accessToken: string,
  projectId: string,
  locationId: string,
): Promise<{ name: string; locationId: string }> {
  const url = `${FIRESTORE_API}/projects/${encodeURIComponent(projectId)}/databases?databaseId=(default)`;
  const op = await post<{ name: string; done?: boolean; response?: { name: string; locationId: string } }>(
    accessToken,
    url,
    { type: 'FIRESTORE_NATIVE', locationId },
  );
  return waitForOperation(accessToken, op);
}

// ─── Long-running-operation polling ───────────────────────────────────

interface LongRunningOperation<R> {
  name: string;
  done?: boolean;
  response?: R;
  error?: { code: number; message: string };
}

/**
 * Poll a long-running operation to completion. Most Management API
 * mutations return an LRO; for the small mutations the playground
 * does (create web app, create database), completion is fast — a
 * few seconds at most. We poll every 1 second up to 30 seconds.
 */
async function waitForOperation<R>(
  accessToken: string,
  initialOp: LongRunningOperation<R>,
): Promise<R> {
  if (initialOp.done) {
    if (initialOp.error) throw new Error(`Operation failed: ${initialOp.error.message}`);
    if (!initialOp.response) throw new Error('Operation completed without response');
    return initialOp.response;
  }
  const url = initialOp.name.startsWith('operations/')
    ? `${FIREBASE_API}/${initialOp.name}`
    : `${FIREBASE_API}/${initialOp.name}`;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const op = await get<LongRunningOperation<R>>(accessToken, url);
    if (op.done) {
      if (op.error) throw new Error(`Operation failed: ${op.error.message}`);
      if (!op.response) throw new Error('Operation completed without response');
      return op.response;
    }
  }
  throw new Error(`Operation ${initialOp.name} did not complete within 30s`);
}
