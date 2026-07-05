/**
 * Smoke tests for the Storage provisioning pure-fetch API. Stubs
 * `fetch` to verify the call shapes + error mapping. No live API
 * usage — the integration coverage is the playground itself.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  enableStorageService,
  getStorageServiceState,
  getDefaultLocation,
  finalizeDefaultLocation,
  listFirebaseBuckets,
  addFirebaseToBucket,
  provisionStorage,
  getBucketCors,
  setBucketCors,
  defaultPlaygroundCors,
  StorageProvisioningError,
} from '../../../src/storage/admin/api.js';

interface FakeResp { status: number; body?: unknown }

function stub(scripted: Array<{ urlMatch: string; resp: FakeResp }>): { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  // @ts-expect-error — overriding global for the test.
  globalThis.fetch = async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init });
    const hit = scripted.find((s) => u.includes(s.urlMatch));
    if (!hit) throw new Error(`stub: unexpected fetch ${u}`);
    return new Response(
      typeof hit.resp.body === 'string' ? hit.resp.body : JSON.stringify(hit.resp.body ?? {}),
      { status: hit.resp.status, headers: { 'Content-Type': 'application/json' } },
    );
  };
  return { calls };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('getStorageServiceState', () => {
  test('returns enabled when service.state is ENABLED', async () => {
    stub([{ urlMatch: 'serviceusage.googleapis.com', resp: { status: 200, body: { state: 'ENABLED' } } }]);
    expect(await getStorageServiceState('tok', 'p')).toBe('enabled');
  });

  test('returns disabled when service.state is DISABLED', async () => {
    stub([{ urlMatch: 'serviceusage.googleapis.com', resp: { status: 200, body: { state: 'DISABLED' } } }]);
    expect(await getStorageServiceState('tok', 'p')).toBe('disabled');
  });

  test('returns unknown when the probe is denied', async () => {
    stub([{ urlMatch: 'serviceusage.googleapis.com', resp: { status: 403, body: { error: { message: 'no' } } } }]);
    expect(await getStorageServiceState('tok', 'p')).toBe('unknown');
  });
});

describe('enableStorageService', () => {
  test('POSTs to services/{s}:enable on the project', async () => {
    const { calls } = stub([{ urlMatch: ':enable', resp: { status: 200, body: {} } }]);
    await enableStorageService('tok', 'my-project');
    expect(calls[0]!.url).toContain('/projects/my-project/services/firebasestorage.googleapis.com:enable');
    expect(calls[0]!.init?.method).toBe('POST');
    const auth = (calls[0]!.init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe('Bearer tok');
  });

  test('throws StorageProvisioningError with reason on 403', async () => {
    stub([{
      urlMatch: ':enable',
      resp: {
        status: 403,
        body: {
          error: {
            message: 'denied',
            details: [{ reason: 'AUTH_PERMISSION_DENIED' }],
          },
        },
      },
    }]);
    let err: unknown;
    try { await enableStorageService('tok', 'p'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StorageProvisioningError);
    expect((err as StorageProvisioningError).reason).toBe('AUTH_PERMISSION_DENIED');
    expect((err as StorageProvisioningError).status).toBe(403);
  });
});

describe('getDefaultLocation', () => {
  test('returns the locationId when set', async () => {
    stub([{ urlMatch: 'firebase.googleapis.com/v1beta1/projects/p', resp: { status: 200, body: { projectId: 'p', resources: { locationId: 'us-central' } } } }]);
    expect(await getDefaultLocation('tok', 'p')).toBe('us-central');
  });

  test('returns null when resources lacks locationId', async () => {
    stub([{ urlMatch: 'firebase.googleapis.com/v1beta1/projects/p', resp: { status: 200, body: { projectId: 'p', resources: { hostingSite: 'p' } } } }]);
    expect(await getDefaultLocation('tok', 'p')).toBeNull();
  });
});

describe('finalizeDefaultLocation', () => {
  test('POSTs the locationId in the body', async () => {
    const { calls } = stub([{ urlMatch: ':finalize', resp: { status: 200, body: {} } }]);
    await finalizeDefaultLocation('tok', 'p', 'us-central');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ locationId: 'us-central' });
  });

  test('throws on 404 (project already has resources)', async () => {
    stub([{ urlMatch: ':finalize', resp: { status: 404, body: { error: { message: 'NOT_FOUND' } } } }]);
    let err: unknown;
    try { await finalizeDefaultLocation('tok', 'p', 'us-central'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StorageProvisioningError);
    expect((err as StorageProvisioningError).status).toBe(404);
  });
});

describe('listFirebaseBuckets', () => {
  test('parses bucketId from name', async () => {
    stub([{
      urlMatch: 'firebasestorage.googleapis.com/v1beta/projects/p/buckets',
      resp: {
        status: 200,
        body: { buckets: [{ name: 'projects/p/buckets/p.firebasestorage.app' }] },
      },
    }]);
    const b = await listFirebaseBuckets('tok', 'p');
    expect(b).toEqual([{ name: 'projects/p/buckets/p.firebasestorage.app', bucketId: 'p.firebasestorage.app' }]);
  });

  test('throws SERVICE_DISABLED reason when the API is off', async () => {
    stub([{
      urlMatch: 'firebasestorage.googleapis.com',
      resp: {
        status: 403,
        body: { error: { message: 'disabled', details: [{ reason: 'SERVICE_DISABLED' }] } },
      },
    }]);
    let err: unknown;
    try { await listFirebaseBuckets('tok', 'p'); } catch (e) { err = e; }
    expect((err as StorageProvisioningError).reason).toBe('SERVICE_DISABLED');
  });
});

describe('addFirebaseToBucket', () => {
  test('POSTs to {bucketId}:addFirebase', async () => {
    const { calls } = stub([{
      urlMatch: ':addFirebase',
      resp: { status: 200, body: { name: 'projects/p/buckets/p.firebasestorage.app' } },
    }]);
    const result = await addFirebaseToBucket('tok', 'p', 'p.firebasestorage.app');
    expect(calls[0]!.url).toContain('/buckets/p.firebasestorage.app:addFirebase');
    expect(result.bucketId).toBe('p.firebasestorage.app');
  });
});

describe('provisionStorage — orchestration', () => {
  test('skips enable when service already enabled, sets location, creates bucket', async () => {
    stub([
      // Step 1 probe → enabled
      { urlMatch: 'serviceusage.googleapis.com/v1/projects/p/services/firebasestorage', resp: { status: 200, body: { state: 'ENABLED' } } },
      // Step 2 getDefaultLocation → null
      { urlMatch: 'firebase.googleapis.com/v1beta1/projects/p', resp: { status: 200, body: { resources: {} } } },
      // Step 2 finalize
      { urlMatch: ':finalize', resp: { status: 200, body: {} } },
      // Step 3 list → empty
      { urlMatch: 'firebasestorage.googleapis.com/v1beta/projects/p/buckets', resp: { status: 200, body: { buckets: [] } } },
      // Step 3 addFirebase
      { urlMatch: ':addFirebase', resp: { status: 200, body: { name: 'projects/p/buckets/p.firebasestorage.app' } } },
    ]);
    const result = await provisionStorage('tok', 'p');
    expect(result.serviceEnabled).toBe(false);
    expect(result.locationFinalized).toBe(true);
    expect(result.bucketCreated).toBe(true);
    expect(result.bucketId).toBe('p.firebasestorage.app');
  });

  test('reports all-idempotent when nothing to do', async () => {
    stub([
      { urlMatch: 'serviceusage.googleapis.com', resp: { status: 200, body: { state: 'ENABLED' } } },
      { urlMatch: 'firebase.googleapis.com/v1beta1/projects/p', resp: { status: 200, body: { resources: { locationId: 'us-central' } } } },
      { urlMatch: 'firebasestorage.googleapis.com/v1beta/projects/p/buckets', resp: { status: 200, body: { buckets: [{ name: 'projects/p/buckets/p.firebasestorage.app' }] } } },
    ]);
    const result = await provisionStorage('tok', 'p');
    expect(result.serviceEnabled).toBe(false);
    expect(result.locationFinalized).toBe(false);
    expect(result.bucketCreated).toBe(false);
    expect(result.corsApplied).toBe(false);
  });

  test('applies CORS when the option is provided', async () => {
    stub([
      { urlMatch: 'serviceusage.googleapis.com', resp: { status: 200, body: { state: 'ENABLED' } } },
      { urlMatch: 'firebase.googleapis.com/v1beta1/projects/p', resp: { status: 200, body: { resources: { locationId: 'us-central' } } } },
      { urlMatch: 'firebasestorage.googleapis.com/v1beta/projects/p/buckets', resp: { status: 200, body: { buckets: [{ name: 'projects/p/buckets/p.firebasestorage.app' }] } } },
      { urlMatch: 'storage.googleapis.com/storage/v1/b/p.firebasestorage.app', resp: { status: 200, body: {} } },
    ]);
    const result = await provisionStorage('tok', 'p', {
      cors: defaultPlaygroundCors('https://p.web.app'),
    });
    expect(result.corsApplied).toBe(true);
  });

  test('narrates step boundaries via onProgress', async () => {
    stub([
      { urlMatch: 'serviceusage.googleapis.com', resp: { status: 200, body: { state: 'ENABLED' } } },
      { urlMatch: 'firebase.googleapis.com/v1beta1/projects/p', resp: { status: 200, body: { resources: { locationId: 'us-central' } } } },
      { urlMatch: 'firebasestorage.googleapis.com/v1beta/projects/p/buckets', resp: { status: 200, body: { buckets: [] } } },
      { urlMatch: ':addFirebase', resp: { status: 200, body: { name: 'projects/p/buckets/p.firebasestorage.app' } } },
    ]);
    const steps: string[] = [];
    await provisionStorage('tok', 'p', { onProgress: (e) => steps.push(`${e.step}:${e.status}`) });
    expect(steps).toContain('enable-service:skip');
    expect(steps).toContain('bucket:start');
  });
});

describe('CORS helpers', () => {
  test('getBucketCors returns the cors array', async () => {
    stub([{
      urlMatch: 'storage.googleapis.com/storage/v1/b/my-bucket',
      resp: { status: 200, body: { cors: [{ origin: ['https://example.com'], method: ['GET'] }] } },
    }]);
    const cors = await getBucketCors('tok', 'my-bucket');
    expect(cors).toEqual([{ origin: ['https://example.com'], method: ['GET'] }]);
  });

  test('getBucketCors returns empty when no cors field', async () => {
    stub([{
      urlMatch: 'storage.googleapis.com/storage/v1/b/my-bucket',
      resp: { status: 200, body: {} },
    }]);
    expect(await getBucketCors('tok', 'my-bucket')).toEqual([]);
  });

  test('setBucketCors PATCHes the cors field', async () => {
    const { calls } = stub([{
      urlMatch: 'storage.googleapis.com/storage/v1/b/my-bucket',
      resp: { status: 200, body: {} },
    }]);
    const rules = defaultPlaygroundCors('https://my-app.web.app');
    await setBucketCors('tok', 'my-bucket', rules);
    expect(calls[0]!.init?.method).toBe('PATCH');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ cors: rules });
  });

  test('setBucketCors throws on permission denied', async () => {
    stub([{
      urlMatch: 'storage.googleapis.com/storage/v1/b/my-bucket',
      resp: { status: 403, body: { error: { message: 'denied', details: [{ reason: 'IAM_PERMISSION_DENIED' }] } } },
    }]);
    let err: unknown;
    try { await setBucketCors('tok', 'my-bucket', []); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StorageProvisioningError);
    expect((err as StorageProvisioningError).status).toBe(403);
  });

  test('defaultPlaygroundCors produces sensible defaults', () => {
    const rules = defaultPlaygroundCors('https://my-app.web.app');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.origin).toContain('https://my-app.web.app');
    expect(rules[0]!.method).toContain('GET');
    expect(rules[0]!.method).toContain('POST');
    expect(rules[0]!.maxAgeSeconds).toBe(3600);
  });
});
