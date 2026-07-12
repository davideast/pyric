/**
 * Smoke tests for the four-call deploy dance. Mocks `globalThis.fetch`
 * for every URL pattern (generateUploadUrl, signed-URL PUT, create,
 * operation poll). Asserts request shapes and the various failure
 * branches.
 *
 * Polling uses real `setTimeout` here — kept tiny via short backoff
 * overrides on the operation helper... wait, actually the core
 * doesn't expose those. We instead arrange for the operation to be
 * `done: true` on the first poll, so no sleep elapses.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { deployFunctions } from '../../../src/deploy/functions/core.js';

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
    calls.push({ url, method, body: parsed, headers });
    return handler({ url, method, body: parsed, headers });
  }) as typeof fetch;
}

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = originalFetch; });

const tinyZip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

function happyPath(uri: string): (call: FetchCall) => Response {
  return (call: FetchCall) => {
    if (call.url.endsWith(':generateUploadUrl')) {
      return new Response(JSON.stringify({
        uploadUrl: 'https://upload.example/signed',
        storageSource: { bucket: 'b', object: 'o' },
      }), { status: 200 });
    }
    if (call.url === 'https://upload.example/signed' && call.method === 'PUT') {
      return new Response('', { status: 200 });
    }
    if (call.url.includes('/functions?functionId=') && call.method === 'POST') {
      return new Response(JSON.stringify({ name: 'operations/op1', done: false }), { status: 200 });
    }
    if (call.url.endsWith('operations/op1') || call.url.includes('operations/op1')) {
      return new Response(JSON.stringify({
        name: 'operations/op1',
        done: true,
        response: { name: 'projects/p/locations/us-central1/functions/fn1', serviceConfig: { uri } },
      }), { status: 200 });
    }
    return new Response('unexpected', { status: 500 });
  };
}

describe('deployFunctions — happy path', () => {
  test('runs generateUploadUrl → PUT → create → poll → returns uri', async () => {
    mockFetch(happyPath('https://fn1-abcd.run.app'));
    const result = await deployFunctions({
      projectId: 'p',
      sourceZip: tinyZip,
      accessToken: 'tok',
      functions: [
        { id: 'fn1', entryPoint: 'handler' },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.deployed).toEqual([
      { id: 'fn1', region: 'us-central1', uri: 'https://fn1-abcd.run.app', publicInvoker: false },
    ]);

    // Body shape on create.
    const createCall = calls.find((c) => c.url.includes('/functions?functionId=fn1') && c.method === 'POST');
    expect(createCall).toBeDefined();
    const body = createCall!.body as Record<string, unknown>;
    expect(body.name).toBe('projects/p/locations/us-central1/functions/fn1');
    const buildConfig = body.buildConfig as Record<string, unknown>;
    expect(buildConfig.runtime).toBe('nodejs22');
    expect(buildConfig.entryPoint).toBe('handler');
    expect((buildConfig.source as Record<string, unknown>).storageSource).toEqual({ bucket: 'b', object: 'o' });
    const serviceConfig = body.serviceConfig as Record<string, unknown>;
    expect(serviceConfig.availableMemory).toBe('256Mi');
    expect(serviceConfig.timeoutSeconds).toBe(60);
  });

  test('per-function overrides flow through serviceConfig', async () => {
    mockFetch(happyPath('https://fn-uri'));
    await deployFunctions({
      projectId: 'p',
      sourceZip: tinyZip,
      accessToken: 'tok',
      defaultRuntime: 'nodejs20',
      functions: [{
        id: 'fn1',
        entryPoint: 'handler',
        memory: '512Mi',
        timeoutSeconds: 300,
        minInstances: 1,
        maxInstances: 50,
        runtime: 'nodejs22', // explicit override beats defaultRuntime
      }],
    });
    const createCall = calls.find((c) => c.url.includes('/functions?functionId=fn1'));
    const body = createCall!.body as Record<string, unknown>;
    expect((body.buildConfig as Record<string, unknown>).runtime).toBe('nodejs22');
    const sc = body.serviceConfig as Record<string, unknown>;
    expect(sc).toEqual({
      availableMemory: '512Mi',
      timeoutSeconds: 300,
      minInstanceCount: 1,
      maxInstanceCount: 50,
    });
  });

  test('409 on create falls back to PATCH', async () => {
    let createCount = 0;
    mockFetch((call) => {
      if (call.url.endsWith(':generateUploadUrl')) {
        return new Response(JSON.stringify({ uploadUrl: 'https://u', storageSource: { bucket: 'b', object: 'o' } }), { status: 200 });
      }
      if (call.url === 'https://u' && call.method === 'PUT') return new Response('', { status: 200 });
      if (call.url.includes('functions?functionId=fn1') && call.method === 'POST') {
        createCount++;
        return new Response('already exists', { status: 409 });
      }
      if (call.url.includes('functions/fn1?updateMask=') && call.method === 'PATCH') {
        return new Response(JSON.stringify({ name: 'operations/op1', done: false }), { status: 200 });
      }
      if (call.url.includes('operations/op1')) {
        return new Response(JSON.stringify({
          name: 'operations/op1', done: true,
          response: { serviceConfig: { uri: 'https://patched' } },
        }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    const result = await deployFunctions({
      projectId: 'p',
      sourceZip: tinyZip,
      accessToken: 'tok',
      functions: [{ id: 'fn1', entryPoint: 'handler' }],
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.deployed[0].uri).toBe('https://patched');
    expect(createCount).toBe(1);
    expect(calls.find((c) => c.method === 'PATCH')).toBeDefined();
  });
});

describe('deployFunctions — error mapping', () => {
  test('public invoker → setIamPolicy on the underlying Run service', async () => {
    let iamCall: FetchCall | undefined;
    mockFetch((call) => {
      if (call.url.includes('run.googleapis.com') && call.url.endsWith(':setIamPolicy')) {
        iamCall = call;
        return new Response('{}', { status: 200 });
      }
      return happyPath('https://fn-uri')(call);
    });
    const result = await deployFunctions({
      projectId: 'p',
      sourceZip: tinyZip,
      accessToken: 'tok',
      functions: [{ id: 'fn1', entryPoint: 'handler', invoker: 'public' }],
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.data.deployed[0].publicInvoker).toBe(true);
    // Cloud Functions Gen 2 service names are the function id
    // lowercased — the IAM grant must target that, not the
    // camelCase id verbatim.
    expect(iamCall?.url).toBe(
      'https://run.googleapis.com/v2/projects/p/locations/us-central1/services/fn1:setIamPolicy',
    );
    expect(iamCall?.body).toEqual({
      policy: {
        bindings: [
          { role: 'roles/run.invoker', members: ['allUsers'] },
        ],
      },
    });
  });

  test('IAM grant lowercases the function id for the Cloud Run service path', async () => {
    let iamUrl: string | undefined;
    mockFetch((call) => {
      if (call.url.includes('run.googleapis.com') && call.url.endsWith(':setIamPolicy')) {
        iamUrl = call.url;
        return new Response('{}', { status: 200 });
      }
      // Re-use happy path keyed off whatever function id is in the URL.
      if (call.url.includes('functions?functionId=stitchProxy')) {
        return new Response(JSON.stringify({ name: 'operations/op1', done: false }), { status: 200 });
      }
      if (call.url.endsWith(':generateUploadUrl')) {
        return new Response(JSON.stringify({
          uploadUrl: 'https://upload.example/signed',
          storageSource: { bucket: 'b', object: 'o' },
        }), { status: 200 });
      }
      if (call.url === 'https://upload.example/signed' && call.method === 'PUT') {
        return new Response('', { status: 200 });
      }
      if (call.url.includes('operations/op1')) {
        return new Response(JSON.stringify({
          name: 'operations/op1', done: true,
          response: { serviceConfig: { uri: 'https://stitchproxy-x-uc.run.app' } },
        }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    await deployFunctions({
      projectId: 'p',
      sourceZip: tinyZip,
      accessToken: 'tok',
      functions: [{ id: 'stitchProxy', entryPoint: 'stitchProxy', invoker: 'public' }],
    });
    expect(iamUrl).toBe(
      'https://run.googleapis.com/v2/projects/p/locations/us-central1/services/stitchproxy:setIamPolicy',
    );
  });

  test('IAM grant 403 → IAM_GRANT_FAILED with role hint', async () => {
    mockFetch((call) => {
      if (call.url.includes('run.googleapis.com') && call.url.endsWith(':setIamPolicy')) {
        return new Response('forbidden', { status: 403 });
      }
      return happyPath('https://fn-uri')(call);
    });
    const result = await deployFunctions({
      projectId: 'p',
      sourceZip: tinyZip,
      accessToken: 'tok',
      functions: [{ id: 'fn1', entryPoint: 'handler', invoker: 'public' }],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('IAM_GRANT_FAILED');
    expect(result.error.message).toContain('roles/run.admin');
    expect(result.error.functionIndex).toBe(0);
  });

  test('403 on generateUploadUrl → PERMISSION_DENIED with IAM hint', async () => {
    mockFetch(() => new Response('denied', { status: 403 }));
    const result = await deployFunctions({
      projectId: 'p',
      sourceZip: tinyZip,
      accessToken: 'tok',
      functions: [{ id: 'fn1', entryPoint: 'handler' }],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('PERMISSION_DENIED');
    expect(result.error.message).toContain('roles/cloudfunctions.developer');
  });

  test('failed operation → OPERATION_FAILED with upstream message', async () => {
    mockFetch((call) => {
      if (call.url.endsWith(':generateUploadUrl')) {
        return new Response(JSON.stringify({ uploadUrl: 'https://u', storageSource: { bucket: 'b', object: 'o' } }), { status: 200 });
      }
      if (call.url === 'https://u' && call.method === 'PUT') return new Response('', { status: 200 });
      if (call.url.includes('functions?functionId=fn1') && call.method === 'POST') {
        return new Response(JSON.stringify({ name: 'operations/op1', done: false }), { status: 200 });
      }
      if (call.url.includes('operations/op1')) {
        return new Response(JSON.stringify({
          name: 'operations/op1', done: true,
          error: { code: 13, message: 'build failed: missing entrypoint' },
        }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    });
    const result = await deployFunctions({
      projectId: 'p',
      sourceZip: tinyZip,
      accessToken: 'tok',
      functions: [{ id: 'fn1', entryPoint: 'handler' }],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('OPERATION_FAILED');
    expect(result.error.message).toContain('build failed');
  });
});

describe('deployFunctions — input validation', () => {
  test('empty functions rejected', async () => {
    const result = await deployFunctions({
      projectId: 'p', sourceZip: tinyZip, accessToken: 'tok', functions: [],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  test('empty zip rejected', async () => {
    const result = await deployFunctions({
      projectId: 'p', sourceZip: new Uint8Array(0), accessToken: 'tok',
      functions: [{ id: 'fn1', entryPoint: 'handler' }],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_INPUT');
  });

  test('function missing entryPoint rejected', async () => {
    // @ts-expect-error testing runtime validation
    const result = await deployFunctions({
      projectId: 'p', sourceZip: tinyZip, accessToken: 'tok',
      functions: [{ id: 'fn1' }],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.functionIndex).toBe(0);
  });
});
