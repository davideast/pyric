/**
 * Smoke tests for `deployHostingFiles`. Mock `globalThis.fetch` so we
 * pin the request shapes (URLs, methods, body keys) without hitting
 * the live Hosting API. Each five-call dance is one test.
 *
 * What we deliberately do NOT test here: gzip/sha output bytes (the
 * helpers test themselves), end-to-end propagation (live), or
 * pagination of `uploadRequiredHashes` (Hosting returns at most
 * `files.length` entries, no pagination on the wire).
 */
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { deployHostingFiles } from '../../../src/deploy/hosting/core.js';

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

let calls: FetchCall[];
let originalFetch: typeof fetch;

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? 'GET';
    const body = init?.body;
    let parsed: unknown = body;
    if (typeof body === 'string') {
      try { parsed = JSON.parse(body); } catch { parsed = body; }
    }
    const headers = init?.headers as Record<string, string> | undefined ?? {};
    const call: FetchCall = { url, method, body: parsed, headers };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  // Mock gzip to avoid CompressionStream issue in this environment
  mock.module('../../../src/deploy/hosting/gzip.js', () => ({
    gzip: async (bytes: Uint8Array) => bytes,
  }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const sampleFiles = [
  { path: 'index.html', bytes: new TextEncoder().encode('<html></html>') },
];

function happyPath(): (call: FetchCall) => Response {
  return (call: FetchCall) => {
    if (call.url.endsWith('/versions') && call.method === 'POST') {
      return new Response(JSON.stringify({ name: 'sites/site/versions/v1' }), { status: 200 });
    }
    if (call.url.endsWith(':populateFiles')) {
      return new Response(JSON.stringify({ uploadUrl: 'https://upload.example/v1', uploadRequiredHashes: [] }), { status: 200 });
    }
    if (call.url.includes('?update_mask=status')) {
      return new Response('{}', { status: 200 });
    }
    if (call.url.includes('/releases?versionName=')) {
      return new Response(JSON.stringify({ name: 'sites/site/releases/r1' }), { status: 200 });
    }
    return new Response('unexpected', { status: 500 });
  };
}

describe('deployHostingFiles — happy path', () => {
  test('runs the five-call dance with no config by default', async () => {
    mockFetch(happyPath());
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.siteId).toBe('site');
    expect(result.data.versionName).toBe('sites/site/versions/v1');
    expect(result.data.releaseName).toBe('sites/site/releases/r1');
    expect(result.data.fileCount).toBe(1);
    expect(result.data.uploadedCount).toBe(0); // server said no required hashes

    // versions.create body — config is an empty object when no hosting config passed.
    const createCall = calls.find((c) => c.url.endsWith('/versions') && c.method === 'POST');
    expect(createCall).toBeDefined();
    expect(createCall!.body).toEqual({ config: {} });
  });

  test('threads the hosting config rewrites into versions.create config body', async () => {
    mockFetch(happyPath());
    await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
      config: {
        rewrites: [
          { source: '/api/stitch/**',   function: { functionId: 'stitchProxy', region: 'us-central1' } },
          { source: '/api/stitch-asset', function: { functionId: 'stitchAsset' } },
        ],
      },
    });
    const createCall = calls.find((c) => c.url.endsWith('/versions') && c.method === 'POST');
    expect(createCall!.body).toEqual({
      config: {
        rewrites: [
          { glob: '/api/stitch/**',   function: 'stitchProxy', functionRegion: 'us-central1' },
          { glob: '/api/stitch-asset', function: 'stitchAsset' },
        ],
      },
    });
  });

  test('uploads required hashes returned by populateFiles', async () => {
    let observedUploadUrl: string | null = null;
    mockFetch((call) => {
      if (call.url.endsWith('/versions') && call.method === 'POST') {
        return new Response(JSON.stringify({ name: 'sites/site/versions/v1' }), { status: 200 });
      }
      if (call.url.endsWith(':populateFiles')) {
        return new Response(JSON.stringify({
          uploadUrl: 'https://upload.example/v1',
          // Don't pin to a specific hash — it depends on gzip output.
          // Echo the manifest's hash so the upload phase has work to do.
          uploadRequiredHashes: Object.values((call.body as { files: Record<string, string> }).files),
        }), { status: 200 });
      }
      if (call.url.startsWith('https://upload.example/v1/')) {
        observedUploadUrl = call.url;
        return new Response('{}', { status: 200 });
      }
      if (call.url.includes('?update_mask=status')) {
        return new Response('{}', { status: 200 });
      }
      if (call.url.includes('/releases?versionName=')) {
        return new Response(JSON.stringify({ name: 'sites/site/releases/r1' }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.uploadedCount).toBe(1);
    expect(observedUploadUrl).toMatch(/^https:\/\/upload\.example\/v1\/[a-f0-9]{64}$/);
  });
});

describe('deployHostingFiles — preview channels', () => {
  const channelResource = {
    name: 'projects/12345/sites/site/channels/pr-1',
    url: 'https://site--pr-1-abc123de.web.app',
    expireTime: '2026-06-17T00:00:00Z',
  };

  /** happyPath + the channel create/release endpoints. */
  function channelHappyPath(): (call: FetchCall) => Response {
    const base = happyPath();
    return (call: FetchCall) => {
      if (call.url.includes('/channels?channelId=')) {
        return new Response(JSON.stringify(channelResource), { status: 200 });
      }
      if (call.url.includes('/channels/pr-1/releases?versionName=')) {
        return new Response(JSON.stringify({ name: 'sites/site/channels/pr-1/releases/r1' }), { status: 200 });
      }
      return base(call);
    };
  }

  test('channel deploy ensures the channel first, then releases onto it', async () => {
    mockFetch(channelHappyPath());
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
      channelId: 'pr-1',
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');

    // Channel ensure happens BEFORE the version is created (fail fast).
    // URL + body pinned by createChannel (clones/firebase-tools/src/
    // hosting/api.ts:332-345); default ttl 7d (expireUtils.ts:32).
    expect(calls[0]?.url).toBe('https://firebasehosting.googleapis.com/v1beta1/projects/-/sites/site/channels?channelId=pr-1');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ ttl: '604800s' });

    // Release lands on the channel's releases collection, pinned by
    // createRelease (api.ts:481-493) — NOT on sites/{site}/releases.
    const releaseCall = calls.find((c) => c.url.includes('/releases?versionName='));
    expect(releaseCall?.url).toBe(
      'https://firebasehosting.googleapis.com/v1beta1/projects/-/sites/site/channels/pr-1/releases?versionName=sites%2Fsite%2Fversions%2Fv1',
    );

    // Success payload carries the SERVER's preview url + expireTime.
    expect(result.data.channelId).toBe('pr-1');
    expect(result.data.channelUrl).toBe('https://site--pr-1-abc123de.web.app');
    expect(result.data.channelExpireTime).toBe('2026-06-17T00:00:00Z');
    expect(result.data.releaseName).toBe('sites/site/channels/pr-1/releases/r1');
  });

  test('channelTtl flows through to the channel create body', async () => {
    mockFetch(channelHappyPath());
    await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
      channelId: 'pr-1',
      channelTtl: '3600s',
    });
    expect(calls[0]?.body).toEqual({ ttl: '3600s' });
  });

  test('live deploy makes NO channel calls and keeps the live release path', async () => {
    mockFetch(happyPath());
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(calls.some((c) => c.url.includes('/channels'))).toBe(false);
    const releaseCall = calls.find((c) => c.url.includes('/releases?versionName='));
    expect(releaseCall?.url).toBe(
      'https://firebasehosting.googleapis.com/v1beta1/sites/site/releases?versionName=sites%2Fsite%2Fversions%2Fv1',
    );
    expect(result.data.channelId).toBeUndefined();
    expect(result.data.channelUrl).toBeUndefined();
  });

  test("channelId 'live' is the live channel — same path as omitting it", async () => {
    mockFetch(happyPath());
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
      channelId: 'live',
    });
    expect(result.success).toBe(true);
    expect(calls.some((c) => c.url.includes('/channels'))).toBe(false);
  });

  test('channel ensure failure aborts before any version is created', async () => {
    mockFetch(() => new Response('boom', { status: 500 }));
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
      channelId: 'pr-1',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('CHANNEL_FAILED');
    expect(calls.length).toBe(1); // only the channel create — nothing uploaded
  });

  test('403 on channel ensure → PERMISSION_DENIED with role hint', async () => {
    mockFetch(() => new Response('forbidden', { status: 403 }));
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
      channelId: 'pr-1',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('PERMISSION_DENIED');
    expect(result.error.message).toContain('roles/firebasehosting.admin');
  });

  test('empty channelId rejected as INVALID_INPUT', async () => {
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
      channelId: '',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  test('malformed channelTtl rejected as INVALID_INPUT', async () => {
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
      channelId: 'pr-1',
      channelTtl: '7d',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('channelTtl');
  });
});

describe('deployHostingFiles — error mapping', () => {
  test('403 on create → PERMISSION_DENIED with actionable IAM hint', async () => {
    mockFetch(() => new Response('forbidden', { status: 403 }));
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('PERMISSION_DENIED');
    expect(result.error.message).toContain('roles/firebasehosting.admin');
  });

  test('404 on create → SITE_NOT_FOUND', async () => {
    mockFetch(() => new Response('site not found', { status: 404 }));
    const result = await deployHostingFiles({
      siteId: 'no-such-site',
      accessToken: 'token',
      files: sampleFiles,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('SITE_NOT_FOUND');
  });

  test('400 at finalize naming a missing function → REWRITE_TARGET_NOT_FOUND', async () => {
    mockFetch((call) => {
      if (call.url.endsWith('/versions') && call.method === 'POST') {
        return new Response(JSON.stringify({ name: 'sites/site/versions/v1' }), { status: 200 });
      }
      if (call.url.endsWith(':populateFiles')) {
        return new Response(JSON.stringify({ uploadUrl: 'https://upload.example/v1', uploadRequiredHashes: [] }), { status: 200 });
      }
      if (call.url.includes('?update_mask=status')) {
        return new Response(
          `Function 'projects/p/locations/us-central1/functions/missingFn' does not exist`,
          { status: 400 },
        );
      }
      return new Response('unexpected', { status: 500 });
    });
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
      config: { rewrites: [{ source: '/api/**', function: { functionId: 'missingFn' } }] },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('REWRITE_TARGET_NOT_FOUND');
  });

  test('network failure on create → NETWORK_ERROR', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('NETWORK_ERROR');
  });
});

describe('deployHostingFiles — input validation', () => {
  test('empty files array rejected', async () => {
    const result = await deployHostingFiles({ siteId: 'site', accessToken: 'token', files: [] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  test('rewrite missing functionId rejected', async () => {
    const result = await deployHostingFiles({
      siteId: 'site',
      accessToken: 'token',
      files: sampleFiles,
      // @ts-expect-error — testing runtime validation
      config: { rewrites: [{ source: '/api/**', function: { region: 'us-central1' } }] },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toContain('functionId');
  });
});
