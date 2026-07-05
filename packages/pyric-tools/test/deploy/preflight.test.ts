/**
 * `pyric-tools/deploy.preflight` unit tests. Network calls are stubbed
 * via `fetch` mocks following the pattern in `firestore.test.ts`.
 * Integration against the live REST APIs is out of scope here —
 * the playground deploy track owns that.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  runPreflight,
  checkHostingSite,
  checkFirestoreDatabase,
  checkIamPermissions,
  type ProjectScope,
} from '../../src/deploy/index.js';

const originalFetch = globalThis.fetch;

interface FetchCall { url: string; init: RequestInit | undefined }

function installFetchMock(
  matcher: (url: string) => Response | undefined,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    const next = matcher(url);
    if (!next) throw new Error(`Fetch mock had no response for ${url}`);
    return Promise.resolve(next);
  }) as typeof fetch;
  return { calls };
}

function installQueueMock(responses: Response[]): { calls: FetchCall[] } {
  const queue = [...responses];
  const calls: FetchCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`Fetch mock ran out of queued responses (called ${url})`);
    return Promise.resolve(next);
  }) as typeof fetch;
  return { calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

beforeEach(() => { globalThis.fetch = originalFetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

const scope: ProjectScope = { projectId: 'p', resolveToken: async () => 'tkn' };

// ─── checkHostingSite ───────────────────────────────────────────────

describe('preflight.checkHostingSite', () => {
  it('returns ok with site metadata on 200', async () => {
    const { calls } = installQueueMock([
      jsonResponse(200, {
        name: 'projects/123/sites/p',
        defaultUrl: 'https://p.web.app',
        type: 'DEFAULT_SITE',
      }),
    ]);
    const result = await checkHostingSite(scope, 'p');
    expect(result.ok).toBe(true);
    expect(result.id).toBe('hosting-site');
    expect(result.data?.defaultUrl).toBe('https://p.web.app');
    expect(result.data?.siteId).toBe('p');
    expect(calls[0].url).toBe(
      'https://firebasehosting.googleapis.com/v1beta1/projects/p/sites/p',
    );
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer tkn',
    );
  });

  it('returns not-found with hosting console deeplink on 404', async () => {
    installQueueMock([textResponse(404, '{"error":{"message":"site missing"}}')]);
    const result = await checkHostingSite(scope, 'missing-site');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not-found');
    expect(result.consoleUrl).toBe(
      'https://console.firebase.google.com/project/p/hosting',
    );
  });

  it('returns permission-denied on 403', async () => {
    installQueueMock([textResponse(403, '{"error":{"message":"forbidden"}}')]);
    const result = await checkHostingSite(scope, 'p');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('permission-denied');
    expect(result.consoleUrl).toBe(
      'https://console.firebase.google.com/project/p/hosting',
    );
  });

  it('returns service-not-enabled when 403 body reports SERVICE_DISABLED', async () => {
    installQueueMock([
      jsonResponse(403, {
        error: {
          status: 'PERMISSION_DENIED',
          message: 'Firebase Hosting API has not been used in project p',
          details: [{ reason: 'SERVICE_DISABLED' }],
        },
      }),
    ]);
    const result = await checkHostingSite(scope, 'p');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('service-not-enabled');
  });

  it('returns network-error when fetch rejects', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    const result = await checkHostingSite(scope, 'p');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('network-error');
  });
});

// ─── checkFirestoreDatabase ─────────────────────────────────────────

describe('preflight.checkFirestoreDatabase', () => {
  it('returns ok with locationId on 200', async () => {
    const { calls } = installQueueMock([
      jsonResponse(200, {
        name: 'projects/p/databases/(default)',
        locationId: 'nam5',
        type: 'FIRESTORE_NATIVE',
      }),
    ]);
    const result = await checkFirestoreDatabase(scope);
    expect(result.ok).toBe(true);
    expect(result.id).toBe('firestore-db');
    expect(result.data?.locationId).toBe('nam5');
    expect(calls[0].url).toBe(
      'https://firestore.googleapis.com/v1/projects/p/databases/(default)',
    );
  });

  it('returns not-found with firestore console deeplink on 404', async () => {
    installQueueMock([textResponse(404, '{"error":{"message":"not found"}}')]);
    const result = await checkFirestoreDatabase(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not-found');
    expect(result.consoleUrl).toBe(
      'https://console.firebase.google.com/project/p/firestore',
    );
  });

  it('returns permission-denied on 403', async () => {
    installQueueMock([textResponse(403, 'forbidden')]);
    const result = await checkFirestoreDatabase(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('permission-denied');
  });

  it('returns service-not-enabled when 403 body reports SERVICE_DISABLED', async () => {
    installQueueMock([
      jsonResponse(403, {
        error: {
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'SERVICE_DISABLED' }],
        },
      }),
    ]);
    const result = await checkFirestoreDatabase(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('service-not-enabled');
  });
});

// ─── checkIamPermissions ────────────────────────────────────────────

describe('preflight.checkIamPermissions', () => {
  it('returns ok when every requested permission is granted', async () => {
    const { calls } = installQueueMock([
      jsonResponse(200, {
        permissions: [
          'firebase.projects.get',
          'firebasehosting.admin',
          'datastore.databases.get',
          'datastore.databases.create',
        ],
      }),
    ]);
    const result = await checkIamPermissions(scope);
    expect(result.ok).toBe(true);
    expect(result.id).toBe('iam-permissions');
    expect((result.data?.missing as string[]).length).toBe(0);
    expect(calls[0].url).toBe(
      'https://iam.googleapis.com/v1/projects/p:testIamPermissions',
    );
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.permissions).toEqual([
      'firebase.projects.get',
      'firebasehosting.admin',
      'datastore.databases.get',
      'datastore.databases.create',
    ]);
  });

  it('identifies missing permissions when the response omits some', async () => {
    installQueueMock([
      jsonResponse(200, {
        // Caller has hosting + projects.get but no datastore scopes.
        permissions: ['firebase.projects.get', 'firebasehosting.admin'],
      }),
    ]);
    const result = await checkIamPermissions(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('permission-denied');
    expect(result.data?.missing).toEqual([
      'datastore.databases.get',
      'datastore.databases.create',
    ]);
    expect(result.error?.message).toContain('datastore.databases.get');
  });

  it('honors a custom permissions list', async () => {
    const { calls } = installQueueMock([
      jsonResponse(200, { permissions: ['firebase.projects.get'] }),
    ]);
    const result = await checkIamPermissions(scope, ['firebase.projects.get']);
    expect(result.ok).toBe(true);
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.permissions).toEqual(['firebase.projects.get']);
  });

  it('handles an empty `permissions` array in the response as all missing', async () => {
    installQueueMock([jsonResponse(200, {})]);
    const result = await checkIamPermissions(scope, ['firebase.projects.get']);
    expect(result.ok).toBe(false);
    expect(result.data?.missing).toEqual(['firebase.projects.get']);
  });

  it('returns permission-denied on 403 from the endpoint itself', async () => {
    installQueueMock([textResponse(403, 'forbidden')]);
    const result = await checkIamPermissions(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('permission-denied');
  });

  it('returns service-not-enabled when 403 body reports SERVICE_DISABLED', async () => {
    installQueueMock([
      jsonResponse(403, {
        error: {
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'SERVICE_DISABLED' }],
        },
      }),
    ]);
    const result = await checkIamPermissions(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('service-not-enabled');
  });

  it('returns not-found on 404', async () => {
    installQueueMock([textResponse(404, 'no project')]);
    const result = await checkIamPermissions(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not-found');
  });
});

// ─── runPreflight ───────────────────────────────────────────────────

describe('runPreflight', () => {
  it('runs all three checks in parallel and aggregates ok=true', async () => {
    installFetchMock((url) => {
      if (url.startsWith('https://firebasehosting.googleapis.com')) {
        return jsonResponse(200, {
          name: 'projects/123/sites/p',
          defaultUrl: 'https://p.web.app',
        });
      }
      if (url.startsWith('https://firestore.googleapis.com')) {
        return jsonResponse(200, {
          name: 'projects/p/databases/(default)',
          locationId: 'nam5',
        });
      }
      if (url.startsWith('https://iam.googleapis.com')) {
        return jsonResponse(200, {
          permissions: [
            'firebase.projects.get',
            'firebasehosting.admin',
            'datastore.databases.get',
            'datastore.databases.create',
          ],
        });
      }
      return undefined;
    });
    const result = await runPreflight(scope);
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => r.id).sort()).toEqual([
      'firestore-db',
      'hosting-site',
      'iam-permissions',
    ]);
  });

  it('aggregates ok=false when any single check fails', async () => {
    installFetchMock((url) => {
      if (url.startsWith('https://firebasehosting.googleapis.com')) {
        return jsonResponse(200, { name: 'projects/123/sites/p' });
      }
      if (url.startsWith('https://firestore.googleapis.com')) {
        // Firestore not initialized.
        return textResponse(404, '{"error":{"message":"not found"}}');
      }
      if (url.startsWith('https://iam.googleapis.com')) {
        return jsonResponse(200, {
          permissions: [
            'firebase.projects.get',
            'firebasehosting.admin',
            'datastore.databases.get',
            'datastore.databases.create',
          ],
        });
      }
      return undefined;
    });
    const result = await runPreflight(scope);
    expect(result.ok).toBe(false);
    const firestoreResult = result.results.find((r) => r.id === 'firestore-db');
    expect(firestoreResult?.ok).toBe(false);
    expect(firestoreResult?.error?.code).toBe('not-found');
    expect(firestoreResult?.consoleUrl).toBe(
      'https://console.firebase.google.com/project/p/firestore',
    );
    // The other two still pass — partial visibility is the point.
    const other = result.results.filter((r) => r.id !== 'firestore-db');
    expect(other.every((r) => r.ok)).toBe(true);
  });

  it('honors options.checks to run a subset', async () => {
    const { calls } = installFetchMock((url) => {
      if (url.startsWith('https://iam.googleapis.com')) {
        return jsonResponse(200, {
          permissions: ['firebase.projects.get'],
        });
      }
      return undefined;
    });
    const result = await runPreflight(scope, {
      checks: ['iam-permissions'],
      iamPermissions: ['firebase.projects.get'],
    });
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('uses siteId override when probing hosting', async () => {
    const { calls } = installFetchMock((url) => {
      if (url.startsWith('https://firebasehosting.googleapis.com')) {
        return jsonResponse(200, { name: 'projects/123/sites/custom' });
      }
      return undefined;
    });
    await runPreflight(scope, {
      checks: ['hosting-site'],
      siteId: 'custom',
    });
    expect(calls[0].url).toContain('/sites/custom');
  });

  it('defaults siteId to projectId', async () => {
    const { calls } = installFetchMock((url) => {
      if (url.startsWith('https://firebasehosting.googleapis.com')) {
        return jsonResponse(200, { name: 'projects/123/sites/p' });
      }
      return undefined;
    });
    await runPreflight(scope, { checks: ['hosting-site'] });
    expect(calls[0].url).toContain('/sites/p');
  });
});
