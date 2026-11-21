import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FirebaseError, deleteApp, getApps, initializeApp, type FirebaseApp } from 'pyric/app';
import { bindAppRegistrySandbox, resetAppRegistryForTests } from 'pyric/app/internal';
import { CustomProvider, initializeAppCheck } from 'pyric/app-check';
import {
  FunctionsError,
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
  httpsCallableFromURL,
} from 'pyric/functions';
import {
  codeForHTTPStatus,
  createGetFunctions,
  decode,
  encode,
  errorForResponse,
  inProcessAuthToken,
  resetConnectFunctionsEmulatorWarningForTests,
  type FunctionsHostTransport,
} from 'pyric/functions/internal';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = initializeSandbox();
  bindAppRegistrySandbox(sandbox);
  resetConnectFunctionsEmulatorWarningForTests();
});

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
  resetAppRegistryForTests();
  sandbox.dispose();
});

function createTestApp(name = 'fn-app'): FirebaseApp {
  return initializeApp(
    {
      apiKey: 'demo-key',
      appId: '1:000000000000:web:0000000000000000',
      projectId: 'demo-functions-callable',
    },
    name,
  );
}

describe('pyric/functions public surface and wire codec', () => {
  test('exports the exact runtime symbol set of firebase/functions', async () => {
    const mirror = (await import('pyric/functions')) as Record<string, unknown>;
    const upstream = (await import('firebase/functions')) as Record<string, unknown>;
    expect(Object.keys(mirror).sort()).toEqual(Object.keys(upstream).sort());
  });

  test('encodes Date, primitives, arrays, and objects, and rejects NaN and Infinity with Error', () => {
    const stamp = new Date('2026-01-02T03:04:05.006Z');
    expect(encode(undefined)).toBeNull();
    expect(encode(null)).toBeNull();
    expect(encode(stamp)).toBe('2026-01-02T03:04:05.006Z');
    expect(encode({ a: 1, nested: [true, 'ok', null] })).toEqual({
      a: 1,
      nested: [true, 'ok', null],
    });
    expect(() => encode(Number.NaN)).toThrow('Data cannot be encoded in JSON: NaN');
    expect(() => encode(Number.POSITIVE_INFINITY)).toThrow(
      'Data cannot be encoded in JSON: Infinity',
    );
  });

  test('decodes protobuf Int64Value and UInt64Value wrappers and rejects unknown @type', () => {
    expect(
      decode({
        '@type': 'type.googleapis.com/google.protobuf.Int64Value',
        value: '9007199254740992',
      }),
    ).toBe(9007199254740992);
    expect(
      decode({
        '@type': 'type.googleapis.com/google.protobuf.UInt64Value',
        value: '42',
      }),
    ).toBe(42);
    expect(() =>
      decode({ '@type': 'type.googleapis.com/google.protobuf.Any', value: '1' }),
    ).toThrow(/Data cannot be decoded from JSON/);
  });

  test('constructs FunctionsError with FirebaseError name, details, status suffix, and customData.url', () => {
    const direct = new FunctionsError('aborted', 'conflict', { attempt: 2 }, 'https://x.test/fn');
    expect(direct).toBeInstanceOf(Error);
    expect(direct).toBeInstanceOf(FirebaseError);
    expect(direct).toBeInstanceOf(FunctionsError);
    expect(direct.name).toBe('FirebaseError');
    expect(FunctionsError.name).toBe('FunctionsError');
    expect(direct.code).toBe('functions/aborted');
    expect(direct.message).toBe('conflict');
    expect(direct.details).toEqual({ attempt: 2 });
    expect(direct.customData).toEqual({ url: 'https://x.test/fn' });

    expect(codeForHTTPStatus(200)).toBe('ok');
    expect(codeForHTTPStatus(503)).toBe('unavailable');
    expect(codeForHTTPStatus(418)).toBe('unknown');

    const mapped = errorForResponse(
      400,
      {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'bad title',
          details: {
            count: {
              '@type': 'type.googleapis.com/google.protobuf.Int64Value',
              value: '7',
            },
          },
        },
      },
      'https://us-central1-demo.cloudfunctions.net/saveItem',
    );
    expect(mapped?.code).toBe('functions/invalid-argument');
    expect(mapped?.message).toBe('bad title [400]');
    expect(mapped?.details).toEqual({ count: 7 });
    expect(mapped?.customData).toEqual({
      url: 'https://us-central1-demo.cloudfunctions.net/saveItem',
    });

    const unknownStatus = errorForResponse(
      500,
      { error: { status: 'NOT_A_CODE' } },
      'https://us-central1-demo.cloudfunctions.net/saveItem',
    );
    expect(unknownStatus?.code).toBe('functions/internal');
    expect(unknownStatus?.message).toBe('Unknown backend error status: NOT_A_CODE [500]');
  });
});

describe('httpsCallable, httpsCallableFromURL, streaming, and gateway routing', () => {
  test('routes named, cloudfunctions.net, and run.app callables to the gateway and refuses off-machine URLs', async () => {
    const seenUrls: string[] = [];
    const seenHeaders: Array<Record<string, string>> = [];
    const transport: FunctionsHostTransport = {
      gatewayOrigin: async () => 'http://127.0.0.1:5173',
      authToken: async () => 'test-id-token',
      async fetchImpl(input, init) {
        seenUrls.push(input);
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return new Response(JSON.stringify({ result: { ok: true, target: input } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };
    const getHostedFunctions = createGetFunctions(transport, 'test-functions');
    const app = createTestApp();
    let providerCalls = 0;
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          providerCalls += 1;
          return {
            token: `custom-app-check-${providerCalls}`,
            expireTimeMillis: Date.now() + 60_000,
          };
        },
      }),
      isTokenAutoRefreshEnabled: false,
    });

    const fn = getHostedFunctions(app, 'europe-west1');
    expect(getHostedFunctions(app, 'europe-west1')).toBe(fn);
    expect(fn.region).toBe('europe-west1');
    expect(fn.customDomain).toBeNull();

    const namedRes = await httpsCallable(fn, 'saveItem', { limitedUseAppCheckTokens: true })({
      title: 'hello',
    });
    expect(namedRes.data).toEqual({
      ok: true,
      target: 'http://127.0.0.1:5173/demo-functions-callable/europe-west1/saveItem',
    });
    expect(seenHeaders[0]).toMatchObject({
      Authorization: 'Bearer test-id-token',
      'X-Firebase-AppCheck': 'custom-app-check-1',
      'Content-Type': 'application/json',
    });

    await httpsCallableFromURL(
      fn,
      'https://us-central1-demo-functions-callable.cloudfunctions.net/saveItem',
    )({});
    await httpsCallableFromURL(fn, 'https://saveitem-pyric-ew.a.run.app')({});
    await httpsCallableFromURL(fn, 'https://saveitem-123456.us-east1.run.app')({});

    expect(seenUrls).toEqual([
      'http://127.0.0.1:5173/demo-functions-callable/europe-west1/saveItem',
      'http://127.0.0.1:5173/demo-functions-callable/us-central1/saveItem',
      'http://127.0.0.1:5173/demo-functions-callable/europe-west1/saveitem?__pyric_run_service=1',
      'http://127.0.0.1:5173/demo-functions-callable/us-east1/saveitem?__pyric_run_service=1',
    ]);

    await expect(
      httpsCallableFromURL(fn, 'https://attacker.example/saveItem')({}),
    ).rejects.toMatchObject({
      code: 'functions/unavailable',
      customData: { url: 'https://attacker.example/saveItem' },
    });
    expect(seenUrls).toHaveLength(4);
  });

  test('warns once on connectFunctionsEmulator and keeps routing to the gateway', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    };
    try {
      const app = createTestApp();
      const fn = getFunctions(app, 'http://127.0.0.1:5999');
      expect(fn.customDomain).toBe('http://127.0.0.1:5999');
      expect(fn.region).toBe('us-central1');
      connectFunctionsEmulator(fn, '127.0.0.1', 5001);
      connectFunctionsEmulator(fn, '127.0.0.1', 5001);
      expect(warnings.filter((line) => line.includes('connectFunctionsEmulator'))).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('enforces client timeout with deadline-exceeded and cancels in-flight calls on deleteApp', async () => {
    const transport: FunctionsHostTransport = {
      gatewayOrigin: async () => 'http://127.0.0.1:5173',
      authToken: inProcessAuthToken,
      fetchImpl: () => new Promise<Response>(() => {}),
    };
    const getHostedFunctions = createGetFunctions(transport, 'timeout-functions');
    const app = createTestApp('timeout-app');
    const fn = getHostedFunctions(app);

    await expect(
      httpsCallable(fn, 'slowItem', { timeout: 40 })({}),
    ).rejects.toMatchObject({
      name: 'FirebaseError',
      code: 'functions/deadline-exceeded',
      message: 'deadline-exceeded',
    });

    const pending = httpsCallable(fn, 'slowItem', { timeout: 5_000 })({});
    await deleteApp(app);
    await expect(pending).rejects.toMatchObject({
      code: 'functions/cancelled',
      message: 'Firebase Functions instance was deleted.',
    });
  });

  test('streams SSE message frames, ignores comment heartbeats, resolves result, and rejects on error frame', async () => {
    let mode = 'ok';
    const encoder = new TextEncoder();
    const transport: FunctionsHostTransport = {
      gatewayOrigin: async () => 'http://127.0.0.1:5173',
      authToken: async () => null,
      async fetchImpl() {
        const currentMode = mode;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(': ping\n\n'));
            controller.enqueue(encoder.encode('data: {"message":{"step":1}}\n\n'));
            if (currentMode === 'fail') {
              controller.enqueue(
                encoder.encode(
                  'data: {"error":{"status":"FAILED_PRECONDITION","message":"halted","details":{"at":1}}}\n\n',
                ),
              );
            } else {
              controller.enqueue(encoder.encode('data: {"message":{"step":2}}\n\n'));
              controller.enqueue(encoder.encode('data: {"result":{"done":true}}\n\n'));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    };
    const getHostedFunctions = createGetFunctions(transport, 'stream-functions');
    const fn = getHostedFunctions(createTestApp('stream-app'));
    const callable = httpsCallable<{ count: number }, { done: boolean }, { step: number }>(
      fn,
      'streamItems',
    );

    const okStream = await callable.stream({ count: 2 });
    const chunks: Array<{ step: number }> = [];
    for await (const chunk of okStream.stream) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([{ step: 1 }, { step: 2 }]);
    expect(await okStream.data).toEqual({ done: true });

    mode = 'fail';
    const failedStream = await callable.stream({ count: 2 });
    const partial: Array<{ step: number }> = [];
    await expect(
      (async () => {
        for await (const chunk of failedStream.stream) {
          partial.push(chunk);
        }
      })(),
    ).rejects.toMatchObject({
      code: 'functions/failed-precondition',
      message: 'halted [0]',
      details: { at: 1 },
    });
    expect(partial).toEqual([{ step: 1 }]);
    await expect(failedStream.data).rejects.toMatchObject({
      code: 'functions/failed-precondition',
      message: 'halted [0]',
    });
  });
});
