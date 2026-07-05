/**
 * Pure-fetch client for the Firebase Storage provisioning APIs.
 * Takes an OAuth access token directly — works equally from a Node
 * agent runtime or a browser. Used by:
 *
 *   - `ProvisionStorageHandler` server-side via the agent SDK
 *   - Consumers like the multi-tenant playground via direct import
 *
 * The caller is responsible for token scope. `firebase` scope is
 * enough for the `:addFirebase` + `defaultLocation:finalize` calls,
 * but **NOT** for enabling the underlying `firebasestorage.googleapis.com`
 * service (which is the first-time gate). Service-enable requires
 * `cloud-platform` scope OR a service account with
 * `roles/serviceusage.serviceUsageAdmin`. Each function below
 * documents which scope it needs.
 *
 * Endpoints under play:
 *   - serviceusage.googleapis.com/v1/projects/{p}/services/{s}:enable
 *   - firebase.googleapis.com/v1beta1/projects/{p}/defaultLocation:finalize
 *   - firebasestorage.googleapis.com/v1beta/projects/{p}/buckets
 *   - firebasestorage.googleapis.com/v1beta/projects/{p}/buckets/{b}:addFirebase
 *   - firebaserules.googleapis.com/v1/projects/{p}/releases/firebase.storage
 */

const SERVICEUSAGE_API = 'https://serviceusage.googleapis.com/v1';
const FIREBASE_API = 'https://firebase.googleapis.com/v1beta1';
const STORAGE_API = 'https://firebasestorage.googleapis.com/v1beta';
const RULES_API = 'https://firebaserules.googleapis.com/v1';
const GCS_API = 'https://storage.googleapis.com/storage/v1';

const STORAGE_SERVICE = 'firebasestorage.googleapis.com';

export class StorageProvisioningError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'StorageProvisioningError';
  }
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{
      '@type'?: string;
      reason?: string;
      metadata?: Record<string, string>;
    }>;
  };
}

function parseError(body: string): { reason: string | undefined; message: string } {
  try {
    const parsed = JSON.parse(body) as GoogleErrorBody;
    const reason = parsed.error?.details?.find((d) => d.reason)?.reason;
    return {
      reason,
      message: parsed.error?.message ?? body.slice(0, 400),
    };
  } catch {
    return { reason: undefined, message: body.slice(0, 400) };
  }
}

async function bearer(accessToken: string, url: string, init?: RequestInit) {
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = r.ok ? '' : await r.text().catch(() => '');
  return { status: r.status, ok: r.ok, body, response: r };
}

// ─── Service enablement (the gate) ────────────────────────────────────

export type ServiceEnableState = 'enabled' | 'disabled' | 'unknown';

/**
 * Probe whether the `firebasestorage.googleapis.com` service is
 * enabled on the project. Cheap, uses Service Usage `GET`. Requires
 * `serviceusage.services.get` permission (the default Firebase Admin
 * SDK SA has this; user OAuth tokens with `firebase` scope do not).
 *
 * Returns `'unknown'` on permission failures so callers can downgrade
 * to "try the operation; observe SERVICE_DISABLED" rather than block.
 */
export async function getStorageServiceState(
  accessToken: string,
  projectId: string,
): Promise<ServiceEnableState> {
  const r = await bearer(
    accessToken,
    `${SERVICEUSAGE_API}/projects/${encodeURIComponent(projectId)}/services/${STORAGE_SERVICE}`,
  );
  if (!r.ok) return 'unknown';
  const parsed = await r.response.json() as { state?: 'ENABLED' | 'DISABLED' };
  if (parsed.state === 'ENABLED') return 'enabled';
  if (parsed.state === 'DISABLED') return 'disabled';
  return 'unknown';
}

/**
 * Enable `firebasestorage.googleapis.com` on the project. Requires
 * `serviceusage.services.enable` IAM permission — included in
 * `roles/owner`, `roles/editor` (deprecated), or
 * `roles/serviceusage.serviceUsageAdmin`. The default Firebase Admin
 * SDK service account does NOT have this; the caller's token must
 * either be a user-OAuth with `cloud-platform` scope or a SA with
 * the elevated role.
 *
 * Long-running operation under the hood; the response carries an
 * operation name. We don't poll — the response 200 is enough signal
 * for our purposes, and a brief settle delay handles propagation.
 */
export async function enableStorageService(
  accessToken: string,
  projectId: string,
): Promise<void> {
  const r = await bearer(
    accessToken,
    `${SERVICEUSAGE_API}/projects/${encodeURIComponent(projectId)}/services/${STORAGE_SERVICE}:enable`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  if (!r.ok) {
    const { reason, message } = parseError(r.body);
    throw new StorageProvisioningError(
      r.status,
      r.body,
      reason,
      `Failed to enable ${STORAGE_SERVICE}: ${r.status} ${message}`,
    );
  }
}

// ─── Default location ─────────────────────────────────────────────────

/**
 * Read the project's current default GCP resources location. Returns
 * null when the project hasn't been finalized yet — e.g. brand-new
 * Firebase projects with no resources. `firebase` scope is sufficient.
 */
export async function getDefaultLocation(
  accessToken: string,
  projectId: string,
): Promise<string | null> {
  const r = await bearer(
    accessToken,
    `${FIREBASE_API}/projects/${encodeURIComponent(projectId)}`,
  );
  if (!r.ok) {
    const { message } = parseError(r.body);
    throw new StorageProvisioningError(r.status, r.body, undefined, `getProject: ${r.status} ${message}`);
  }
  const project = await r.response.json() as { resources?: { locationId?: string } };
  return project.resources?.locationId ?? null;
}

/**
 * Set the project's default GCP resources location. IRREVERSIBLE —
 * once set, the location cannot be changed. Skip-if-set is the
 * caller's job; this function unconditionally calls `:finalize`.
 *
 * Per observed behavior, `:finalize` 404s on projects that already
 * have resources provisioned (RTDB, Hosting) without a default
 * location. The error path surfaces that to the caller.
 */
export async function finalizeDefaultLocation(
  accessToken: string,
  projectId: string,
  locationId: string,
): Promise<void> {
  const r = await bearer(
    accessToken,
    `${FIREBASE_API}/projects/${encodeURIComponent(projectId)}/defaultLocation:finalize`,
    { method: 'POST', body: JSON.stringify({ locationId }) },
  );
  if (!r.ok) {
    const { reason, message } = parseError(r.body);
    throw new StorageProvisioningError(
      r.status,
      r.body,
      reason,
      `defaultLocation:finalize ${locationId}: ${r.status} ${message}`,
    );
  }
}

// ─── Firebase Storage buckets ─────────────────────────────────────────

export interface FirebaseStorageBucket {
  name: string;              // projects/{p}/buckets/{bucketId}
  bucketId: string;          // {bucketId} only
  reconciling?: boolean;
}

/**
 * List Firebase-linked Storage buckets on the project. Returns an
 * empty list when none exist yet. Throws when the underlying service
 * is disabled — callers should check `getStorageServiceState` first
 * if they want to distinguish.
 */
export async function listFirebaseBuckets(
  accessToken: string,
  projectId: string,
): Promise<FirebaseStorageBucket[]> {
  const r = await bearer(
    accessToken,
    `${STORAGE_API}/projects/${encodeURIComponent(projectId)}/buckets`,
  );
  if (!r.ok) {
    const { reason, message } = parseError(r.body);
    throw new StorageProvisioningError(
      r.status,
      r.body,
      reason,
      `listBuckets: ${r.status} ${message}`,
    );
  }
  const body = await r.response.json() as { buckets?: Array<{ name: string }> };
  return (body.buckets ?? []).map((b) => ({
    name: b.name,
    bucketId: b.name.split('/').pop() ?? b.name,
  }));
}

/**
 * Link a Cloud Storage bucket to Firebase Storage. Idempotent — if
 * the bucket is already Firebase-linked, the API returns 200 with
 * the existing record. The bucket must already exist as a GCS
 * resource; for the default Firebase bucket name
 * (`{projectId}.firebasestorage.app`), Firebase auto-creates it on
 * first `:addFirebase` call.
 */
export async function addFirebaseToBucket(
  accessToken: string,
  projectId: string,
  bucketId: string,
): Promise<FirebaseStorageBucket> {
  const r = await bearer(
    accessToken,
    `${STORAGE_API}/projects/${encodeURIComponent(projectId)}/buckets/${encodeURIComponent(bucketId)}:addFirebase`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  if (!r.ok) {
    const { reason, message } = parseError(r.body);
    throw new StorageProvisioningError(
      r.status,
      r.body,
      reason,
      `addFirebase ${bucketId}: ${r.status} ${message}`,
    );
  }
  const body = await r.response.json() as { name?: string };
  return {
    name: body.name ?? `projects/${projectId}/buckets/${bucketId}`,
    bucketId,
  };
}

// ─── Storage rules helpers ────────────────────────────────────────────

/**
 * Deploy a Storage rules source for a specific bucket. Firebase
 * Storage uses **per-bucket** release names —
 * `projects/{p}/releases/firebase.storage/{bucketId}` — for actual
 * rule application. The project-wide `firebase.storage` release
 * exists as a legacy alias but isn't bound to any bucket in modern
 * projects; deploying to it leaves the bucket's deny-all rule
 * unchanged.
 *
 * Defaults `bucketId` to `{projectId}.firebasestorage.app` (the
 * Firebase default bucket name). Pass an override when targeting a
 * non-default bucket.
 */
export async function deployStorageRules(
  accessToken: string,
  projectId: string,
  source: string,
  bucketId: string = `${projectId}.firebasestorage.app`,
): Promise<{ rulesetName: string }> {
  const headers = { 'Content-Type': 'application/json' };
  const create = await bearer(
    accessToken,
    `${RULES_API}/projects/${encodeURIComponent(projectId)}/rulesets`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: { files: [{ name: 'storage.rules', content: source }] } }),
    },
  );
  if (!create.ok) {
    const { reason, message } = parseError(create.body);
    throw new StorageProvisioningError(
      create.status,
      create.body,
      reason,
      `createRuleset: ${create.status} ${message}`,
    );
  }
  const created = await create.response.json() as { name: string };

  const releaseName = `projects/${projectId}/releases/firebase.storage/${bucketId}`;

  // PATCH updates an existing release; if no release exists yet
  // (project just had Storage enabled, no rules ever deployed),
  // PATCH 404s. Fall back to POST `releases.create` to mint the
  // release the first time.
  const patch = await bearer(
    accessToken,
    `${RULES_API}/${releaseName}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ release: { name: releaseName, rulesetName: created.name } }),
    },
  );
  if (patch.ok) return { rulesetName: created.name };

  if (patch.status === 404) {
    const createRelease = await bearer(
      accessToken,
      `${RULES_API}/projects/${encodeURIComponent(projectId)}/releases`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: releaseName, rulesetName: created.name }),
      },
    );
    if (!createRelease.ok) {
      const { reason, message } = parseError(createRelease.body);
      throw new StorageProvisioningError(
        createRelease.status,
        createRelease.body,
        reason,
        `createRelease firebase.storage/${bucketId}: ${createRelease.status} ${message}`,
      );
    }
    return { rulesetName: created.name };
  }

  const { reason, message } = parseError(patch.body);
  throw new StorageProvisioningError(
    patch.status,
    patch.body,
    reason,
    `updateRelease firebase.storage/${bucketId}: ${patch.status} ${message}`,
  );
}

// ─── Bucket CORS configuration ────────────────────────────────────────
//
// Buckets created via the Cloud Console (vs the Firebase Console)
// often ship with no CORS configuration, which blocks browser
// downloads (`XMLHttpRequest`s from a web origin fail with
// `No 'Access-Control-Allow-Origin' header`). Setting CORS through
// the GCS bucket-update API fixes this in one call.
//
// Permission requirements: the caller's identity needs
// `storage.buckets.update` IAM permission — granted by
// `roles/storage.admin` or by the default Firebase Admin SDK
// service-agent role bundle in modern projects.

/**
 * A single CORS rule entry, mirroring the GCS bucket CORS schema.
 * See https://cloud.google.com/storage/docs/cross-origin#cors-elements.
 */
export interface CorsRule {
  origin: string[];
  method: string[];
  responseHeader?: string[];
  maxAgeSeconds?: number;
}

/**
 * Default rule for a browser playground hosted on Firebase Hosting.
 * Allows GET/POST/PUT/DELETE/HEAD/OPTIONS from the Hosting origin
 * + common localhost dev ports, with response headers needed by the
 * Firebase Storage Web SDK.
 */
export function defaultPlaygroundCors(hostingOrigin: string): CorsRule[] {
  return [{
    origin: [hostingOrigin, 'http://localhost:5173', 'http://localhost:3000', 'http://localhost:4173'],
    method: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'],
    responseHeader: ['Content-Type', 'Authorization', 'x-goog-meta-*', 'x-firebase-storage-version', 'x-goog-upload-*'],
    maxAgeSeconds: 3600,
  }];
}

/** Read the current CORS configuration for a bucket. */
export async function getBucketCors(
  accessToken: string,
  bucketId: string,
): Promise<CorsRule[]> {
  const r = await bearer(
    accessToken,
    `${GCS_API}/b/${encodeURIComponent(bucketId)}?fields=cors`,
  );
  if (!r.ok) {
    const { reason, message } = parseError(r.body);
    throw new StorageProvisioningError(
      r.status,
      r.body,
      reason,
      `getBucketCors ${bucketId}: ${r.status} ${message}`,
    );
  }
  const body = await r.response.json() as { cors?: CorsRule[] };
  return body.cors ?? [];
}

/**
 * Replace the bucket's CORS configuration. Pass an empty array to
 * clear all rules. The GCS API replaces (not merges) the cors field
 * on PATCH.
 */
export async function setBucketCors(
  accessToken: string,
  bucketId: string,
  cors: CorsRule[],
): Promise<void> {
  const r = await bearer(
    accessToken,
    `${GCS_API}/b/${encodeURIComponent(bucketId)}?fields=cors`,
    {
      method: 'PATCH',
      body: JSON.stringify({ cors }),
    },
  );
  if (!r.ok) {
    const { reason, message } = parseError(r.body);
    throw new StorageProvisioningError(
      r.status,
      r.body,
      reason,
      `setBucketCors ${bucketId}: ${r.status} ${message}`,
    );
  }
}

// ─── High-level: full provisioning sequence ───────────────────────────

/**
 * Step-boundary progress narration for {@link provisionStorage}. Lets a caller
 * (the deploy CLI's status board) narrate the multi-second flow — most
 * importantly the post-enable settle wait, which is otherwise a frozen terminal.
 */
export type ProvisionProgress = (event: {
  step: string;
  status: 'start' | 'done' | 'skip' | 'progress';
  message: string;
  pct?: number;
}) => void;

export interface ProvisionStorageOptions {
  /**
   * Default GCP resources location to use if the project hasn't been
   * finalized yet. Ignored when the location is already set.
   * Default: `'us-central'`.
   */
  locationId?: string;
  /**
   * Override the default Firebase Storage bucket ID. Defaults to
   * `{projectId}.firebasestorage.app` — the bucket Firebase Console
   * creates automatically.
   */
  bucketId?: string;
  /**
   * Storage rules source to deploy after the bucket is linked. When
   * omitted, no rules are deployed (the project keeps whatever rules
   * were last released — possibly the default deny-all).
   */
  rules?: string;
  /**
   * CORS rules to apply to the bucket after it's linked. Required
   * for browser-side reads/writes from a non-Firebase origin —
   * buckets created via the Cloud Console (vs Firebase Console)
   * often ship with no CORS configuration, which manifests as
   * `No 'Access-Control-Allow-Origin' header` on the first
   * `XMLHttpRequest` from a hosted page.
   *
   * Pass `defaultPlaygroundCors(origin)` for a sensible starter
   * config, or a custom array. Omit to leave the bucket's CORS
   * alone.
   */
  cors?: CorsRule[];
  /** Optional progress callback, invoked at each provisioning step boundary. */
  onProgress?: ProvisionProgress;
}

export interface ProvisionStorageResult {
  ok: true;
  serviceEnabled: boolean;          // true if we enabled it in this run
  locationFinalized: boolean;       // true if we set the location in this run
  locationId: string | null;        // final value
  bucketCreated: boolean;           // true if `:addFirebase` minted a new bucket
  bucketId: string;
  rulesDeployed: boolean;
  rulesetName?: string;
  corsApplied: boolean;             // true if we set CORS in this run
}

/**
 * End-to-end Storage enablement + provisioning. Each step is
 * idempotent (probe before mutating); the result reports what was
 * actually done.
 *
 * Permission requirements (caller's token):
 *   - `roles/serviceusage.serviceUsageAdmin` (or Owner) — to enable
 *     the service when it's disabled
 *   - `cloud-platform` OAuth scope (or `firebase` if service already
 *     enabled)
 *
 * The handler throws `StorageProvisioningError` with the
 * underlying `reason` (e.g. `AUTH_PERMISSION_DENIED`,
 * `SERVICE_DISABLED`) so the caller can route to actionable UX.
 */
export async function provisionStorage(
  accessToken: string,
  projectId: string,
  options: ProvisionStorageOptions = {},
): Promise<ProvisionStorageResult> {
  const locationId = options.locationId ?? 'us-central';
  const bucketId = options.bucketId ?? `${projectId}.firebasestorage.app`;
  const report = options.onProgress;

  // Step 1: enable the service if needed.
  let serviceEnabled = false;
  const state = await getStorageServiceState(accessToken, projectId);
  if (state !== 'enabled') {
    report?.({ step: 'enable-service', status: 'start', message: 'enabling Storage API' });
    await enableStorageService(accessToken, projectId);
    serviceEnabled = true;
    // Brief settle — service-enable is async; immediate buckets
    // calls otherwise still 403 with SERVICE_DISABLED for a few seconds.
    // The progress frame here is what keeps the terminal alive through the wait.
    report?.({ step: 'settle', status: 'start', message: 'waiting for service propagation' });
    await new Promise((r) => setTimeout(r, 5000));
  } else {
    report?.({ step: 'enable-service', status: 'skip', message: 'Storage API already enabled' });
  }

  // Step 2: finalize default location if missing.
  const existingLocation = await getDefaultLocation(accessToken, projectId);
  let locationFinalized = false;
  let finalLocation = existingLocation;
  if (!existingLocation) {
    await finalizeDefaultLocation(accessToken, projectId, locationId);
    locationFinalized = true;
    finalLocation = locationId;
  }

  // Step 3: ensure the default Firebase bucket is linked.
  const existing = await listFirebaseBuckets(accessToken, projectId);
  const alreadyLinked = existing.some((b) => b.bucketId === bucketId);
  let bucketCreated = false;
  if (!alreadyLinked) {
    report?.({ step: 'bucket', status: 'start', message: `creating bucket ${bucketId}` });
    await addFirebaseToBucket(accessToken, projectId, bucketId);
    bucketCreated = true;
  }

  // Step 4: optionally deploy rules.
  let rulesDeployed = false;
  let rulesetName: string | undefined;
  if (options.rules) {
    report?.({ step: 'rules', status: 'start', message: 'deploying Storage rules' });
    const result = await deployStorageRules(accessToken, projectId, options.rules, bucketId);
    rulesDeployed = true;
    rulesetName = result.rulesetName;
  }

  // Step 5: optionally apply CORS. Idempotent — caller passes the
  // desired final state and we PATCH the bucket to match.
  let corsApplied = false;
  if (options.cors) {
    await setBucketCors(accessToken, bucketId, options.cors);
    corsApplied = true;
  }

  return {
    ok: true,
    serviceEnabled,
    locationFinalized,
    locationId: finalLocation,
    bucketCreated,
    bucketId,
    rulesDeployed,
    rulesetName,
    corsApplied,
  };
}
