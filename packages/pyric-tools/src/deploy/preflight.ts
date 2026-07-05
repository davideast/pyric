/**
 * Pre-flight checks for a Firebase project before kicking off a
 * full deploy (hosting + rules + indexes). Three cheap GETs
 * (~200ms total) that surface the common "won't work" conditions
 * up front so the playground can show actionable remediation
 * (Console deeplinks, missing IAM scopes) instead of a half-
 * deployed app.
 *
 * The checks:
 *
 *   - `hosting-site`     — `firebasehosting.googleapis.com` GET on
 *                          `projects/{p}/sites/{siteId}`. Default
 *                          siteId is `projectId` (Firebase auto-
 *                          provisions a default site that matches).
 *   - `firestore-db`     — `firestore.googleapis.com` GET on
 *                          `projects/{p}/databases/(default)`.
 *   - `iam-permissions`  — `iam.googleapis.com` POST
 *                          `projects/{p}:testIamPermissions` for
 *                          the four scopes deploy needs.
 *
 * Every check returns a `PreflightCheckResult`. Error codes mirror
 * the existing deploy primitives' shapes (`permission-denied`,
 * `not-found`, plus `service-not-enabled` when the upstream API
 * is disabled on the target project and `network-error` when
 * fetch rejects). `runPreflight` fans them out in parallel and
 * aggregates.
 *
 * Pure fetch + no `node:*` imports — runs in the browser host
 * (Firebase Auth `getIdToken`) and the Node host (service-account
 * JWT exchange) alike.
 *
 * See the design rationale, the
 * `Pre-flight checks` track, for the audit that produced these
 * three checks and their endpoints.
 */

import type { ProjectScope } from './scope.js';

const HOSTING_API = 'https://firebasehosting.googleapis.com/v1beta1';
const FIRESTORE_API = 'https://firestore.googleapis.com/v1';
const IAM_API = 'https://iam.googleapis.com/v1';

/** Scopes the playground deploy path needs end-to-end. */
const DEFAULT_REQUIRED_PERMISSIONS: readonly string[] = [
  'firebase.projects.get',
  'firebasehosting.admin',
  'datastore.databases.get',
  'datastore.databases.create',
];

export type PreflightCheckId =
  | 'hosting-site'
  | 'firestore-db'
  | 'iam-permissions';

export interface PreflightCheckResult {
  id: PreflightCheckId;
  ok: boolean;
  /** Human-readable summary. Always present. */
  summary: string;
  /**
   * Console deeplink the caller can offer the user to remediate.
   * Present when `ok: false` and a deeplink applies.
   */
  consoleUrl?: string;
  /**
   * Structured error for failed checks. Codes mirror the existing
   * deploy primitives' shapes — 'permission-denied', 'not-found',
   * 'service-not-enabled' (when the API itself is disabled),
   * 'network-error' (fetch reject), 'unknown'.
   */
  error?: {
    code:
      | 'permission-denied'
      | 'not-found'
      | 'service-not-enabled'
      | 'network-error'
      | 'unknown';
    message: string;
  };
  /**
   * The check-specific data returned on success (site name, db
   * locationId, granted permissions list, etc.). Loosely typed —
   * callers can drill into specifics they care about.
   */
  data?: Record<string, unknown>;
}

export interface PreflightOptions {
  /** Defaults to projectId (Firebase auto-provisions a default site). */
  siteId?: string;
  /** Which checks to run. Defaults to all three. */
  checks?: readonly PreflightCheckId[];
  /**
   * Override the permissions list IAM is asked about. Defaults to
   * the four scopes the playground deploy path uses end-to-end.
   */
  iamPermissions?: readonly string[];
}

// ─── helpers ─────────────────────────────────────────────────────────

function hostingConsoleUrl(projectId: string): string {
  return `https://console.firebase.google.com/project/${encodeURIComponent(projectId)}/hosting`;
}

function firestoreConsoleUrl(projectId: string): string {
  return `https://console.firebase.google.com/project/${encodeURIComponent(projectId)}/firestore`;
}

/**
 * Parse a Google REST error body and return its first error
 * reason (e.g. `SERVICE_DISABLED`). Returns `null` when the body
 * isn't JSON, isn't shaped like a Google error, or has no
 * `reason` field. Used to distinguish "API disabled on the
 * project" from a real permission denial.
 */
function extractErrorReason(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        details?: ReadonlyArray<{ reason?: string }>;
        status?: string;
      };
    };
    const detail = parsed.error?.details?.find((d) => typeof d?.reason === 'string');
    if (detail?.reason) return detail.reason;
    if (parsed.error?.status === 'PERMISSION_DENIED') return null;
    return null;
  } catch {
    return null;
  }
}

function extractErrorMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    /* fall through */
  }
  return body || fallback;
}

// ─── individual checks ──────────────────────────────────────────────

/**
 * Probe the named Hosting site. A 200 means the site exists and
 * the caller has permission to read it; 404 means the site
 * doesn't exist yet (uncommon — Firebase auto-creates a default
 * site whose id equals the project id); 401/403 means the
 * caller's credentials lack `firebasehosting.admin` (or the
 * Hosting API is disabled on the project, surfaced as
 * `service-not-enabled`).
 */
export async function checkHostingSite(
  scope: ProjectScope,
  siteId: string,
): Promise<PreflightCheckResult> {
  const id: PreflightCheckId = 'hosting-site';
  let token: string;
  try {
    token = await scope.resolveToken();
  } catch (e) {
    return {
      id,
      ok: false,
      summary: 'Failed to resolve access token for hosting check',
      error: {
        code: 'network-error',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  let res: Response;
  try {
    res = await fetch(
      `${HOSTING_API}/projects/${encodeURIComponent(scope.projectId)}/sites/${encodeURIComponent(siteId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (e) {
    return {
      id,
      ok: false,
      summary: 'Network error contacting Firebase Hosting',
      error: {
        code: 'network-error',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  if (res.ok) {
    const site = (await res.json().catch(() => ({}))) as {
      name?: string;
      defaultUrl?: string;
      type?: string;
    };
    return {
      id,
      ok: true,
      summary: `Hosting site '${siteId}' exists`,
      data: {
        name: site.name,
        defaultUrl: site.defaultUrl,
        type: site.type,
        siteId,
      },
    };
  }

  const body = await res.text().catch(() => '');
  if (res.status === 404) {
    return {
      id,
      ok: false,
      summary: `Hosting site '${siteId}' not found`,
      consoleUrl: hostingConsoleUrl(scope.projectId),
      error: {
        code: 'not-found',
        message: extractErrorMessage(body, `Hosting site '${siteId}' not found`),
      },
    };
  }
  if (res.status === 401 || res.status === 403) {
    const reason = extractErrorReason(body);
    if (reason === 'SERVICE_DISABLED') {
      return {
        id,
        ok: false,
        summary: 'Firebase Hosting API is not enabled on this project',
        consoleUrl: hostingConsoleUrl(scope.projectId),
        error: {
          code: 'service-not-enabled',
          message: extractErrorMessage(body, 'Firebase Hosting API disabled'),
        },
      };
    }
    return {
      id,
      ok: false,
      summary: 'Permission denied reading hosting site',
      consoleUrl: hostingConsoleUrl(scope.projectId),
      error: {
        code: 'permission-denied',
        message: extractErrorMessage(body, `Hosting denied: ${res.status}`),
      },
    };
  }
  return {
    id,
    ok: false,
    summary: `Hosting check failed (HTTP ${res.status})`,
    error: {
      code: 'unknown',
      message: extractErrorMessage(body, `HTTP ${res.status}`),
    },
  };
}

/**
 * Probe the `(default)` Firestore database. A 200 means the
 * database exists; 404 means the user hasn't initialized
 * Firestore in the Console yet (we don't auto-create — the
 * Console flow asks the user to pick a location, which we
 * shouldn't decide for them). 403 + `SERVICE_DISABLED` means the
 * Firestore API itself is off on the project.
 */
export async function checkFirestoreDatabase(
  scope: ProjectScope,
): Promise<PreflightCheckResult> {
  const id: PreflightCheckId = 'firestore-db';
  let token: string;
  try {
    token = await scope.resolveToken();
  } catch (e) {
    return {
      id,
      ok: false,
      summary: 'Failed to resolve access token for firestore check',
      error: {
        code: 'network-error',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  let res: Response;
  try {
    res = await fetch(
      `${FIRESTORE_API}/projects/${encodeURIComponent(scope.projectId)}/databases/(default)`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (e) {
    return {
      id,
      ok: false,
      summary: 'Network error contacting Firestore',
      error: {
        code: 'network-error',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  if (res.ok) {
    const db = (await res.json().catch(() => ({}))) as {
      name?: string;
      locationId?: string;
      type?: string;
    };
    return {
      id,
      ok: true,
      summary: `Firestore default database exists (${db.locationId ?? 'unknown location'})`,
      data: {
        name: db.name,
        locationId: db.locationId,
        type: db.type,
      },
    };
  }

  const body = await res.text().catch(() => '');
  if (res.status === 404) {
    return {
      id,
      ok: false,
      summary: 'Firestore default database not initialized',
      consoleUrl: firestoreConsoleUrl(scope.projectId),
      error: {
        code: 'not-found',
        message: extractErrorMessage(body, 'Firestore default database not found'),
      },
    };
  }
  if (res.status === 401 || res.status === 403) {
    const reason = extractErrorReason(body);
    if (reason === 'SERVICE_DISABLED') {
      return {
        id,
        ok: false,
        summary: 'Cloud Firestore API is not enabled on this project',
        consoleUrl: firestoreConsoleUrl(scope.projectId),
        error: {
          code: 'service-not-enabled',
          message: extractErrorMessage(body, 'Cloud Firestore API disabled'),
        },
      };
    }
    return {
      id,
      ok: false,
      summary: 'Permission denied reading firestore database',
      consoleUrl: firestoreConsoleUrl(scope.projectId),
      error: {
        code: 'permission-denied',
        message: extractErrorMessage(body, `Firestore denied: ${res.status}`),
      },
    };
  }
  return {
    id,
    ok: false,
    summary: `Firestore check failed (HTTP ${res.status})`,
    error: {
      code: 'unknown',
      message: extractErrorMessage(body, `HTTP ${res.status}`),
    },
  };
}

/**
 * Ask IAM which of `permissions` the caller's credentials are
 * granted on the project. Returns `ok: true` only when every
 * requested permission comes back in the response; otherwise
 * marks the result as `permission-denied` and lists the missing
 * scopes in `data.missing`.
 *
 * The endpoint itself needs `iam.permissions.testIamPermissions`
 * (subsumed by Owner/Editor). A 403 from this endpoint usually
 * means the IAM API is off on the project — we surface that as
 * `service-not-enabled` when the body reports `SERVICE_DISABLED`.
 */
export async function checkIamPermissions(
  scope: ProjectScope,
  permissions: readonly string[] = DEFAULT_REQUIRED_PERMISSIONS,
): Promise<PreflightCheckResult> {
  const id: PreflightCheckId = 'iam-permissions';
  let token: string;
  try {
    token = await scope.resolveToken();
  } catch (e) {
    return {
      id,
      ok: false,
      summary: 'Failed to resolve access token for IAM check',
      error: {
        code: 'network-error',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  let res: Response;
  try {
    res = await fetch(
      `${IAM_API}/projects/${encodeURIComponent(scope.projectId)}:testIamPermissions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ permissions }),
      },
    );
  } catch (e) {
    return {
      id,
      ok: false,
      summary: 'Network error contacting IAM',
      error: {
        code: 'network-error',
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  if (res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as {
      permissions?: string[];
    };
    const granted = parsed.permissions ?? [];
    const grantedSet = new Set(granted);
    const missing = permissions.filter((p) => !grantedSet.has(p));
    if (missing.length === 0) {
      return {
        id,
        ok: true,
        summary: `All ${permissions.length} required IAM permissions granted`,
        data: { granted, requested: [...permissions], missing: [] },
      };
    }
    return {
      id,
      ok: false,
      summary: `Missing ${missing.length} of ${permissions.length} required IAM permissions`,
      error: {
        code: 'permission-denied',
        message: `Missing permissions: ${missing.join(', ')}`,
      },
      data: { granted, requested: [...permissions], missing },
    };
  }

  const body = await res.text().catch(() => '');
  if (res.status === 404) {
    return {
      id,
      ok: false,
      summary: `Project '${scope.projectId}' not found by IAM`,
      error: {
        code: 'not-found',
        message: extractErrorMessage(body, 'Project not found'),
      },
    };
  }
  if (res.status === 401 || res.status === 403) {
    const reason = extractErrorReason(body);
    if (reason === 'SERVICE_DISABLED') {
      return {
        id,
        ok: false,
        summary: 'IAM API is not enabled on this project',
        error: {
          code: 'service-not-enabled',
          message: extractErrorMessage(body, 'IAM API disabled'),
        },
      };
    }
    return {
      id,
      ok: false,
      summary: 'Permission denied calling testIamPermissions',
      error: {
        code: 'permission-denied',
        message: extractErrorMessage(body, `IAM denied: ${res.status}`),
      },
    };
  }
  return {
    id,
    ok: false,
    summary: `IAM check failed (HTTP ${res.status})`,
    error: {
      code: 'unknown',
      message: extractErrorMessage(body, `HTTP ${res.status}`),
    },
  };
}

// ─── orchestrator ────────────────────────────────────────────────────

const ALL_CHECKS: readonly PreflightCheckId[] = [
  'hosting-site',
  'firestore-db',
  'iam-permissions',
];

/**
 * Run the selected checks in parallel and aggregate.
 * `options.checks` defaults to all three; `options.siteId`
 * defaults to `projectId` (Firebase's auto-provisioned default
 * site shares the project id). Result `ok` is the conjunction —
 * every check must pass.
 */
export async function runPreflight(
  scope: ProjectScope,
  options: PreflightOptions = {},
): Promise<{ ok: boolean; results: PreflightCheckResult[] }> {
  const siteId = options.siteId ?? scope.projectId;
  const selected = options.checks ?? ALL_CHECKS;
  const permissions = options.iamPermissions ?? DEFAULT_REQUIRED_PERMISSIONS;

  const tasks: Array<Promise<PreflightCheckResult>> = selected.map((id) => {
    switch (id) {
      case 'hosting-site':
        return checkHostingSite(scope, siteId);
      case 'firestore-db':
        return checkFirestoreDatabase(scope);
      case 'iam-permissions':
        return checkIamPermissions(scope, permissions);
    }
  });

  const results = await Promise.all(tasks);
  return { ok: results.every((r) => r.ok), results };
}
