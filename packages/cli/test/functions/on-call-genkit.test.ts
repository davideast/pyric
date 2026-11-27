/**
 * Discovery, HTTP child-server execution (unary, SSE streaming, auth context,
 * HttpsError), and isolated-child integration tests for `onCallGenkit`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mintIdToken } from 'pyric/sandbox/internal';
import { buildChildEnv, registerModuleUrl } from '../../src/cli/sandbox-runner.js';
import { callableOnCallFamily, inspectOnCall } from '../../src/functions/callable/discovery.js';
import {
  FUNCTION_TARGET_HEADER,
  startHttpChildServer,
  type HttpChildServer,
} from '../../src/functions/http/child-server.js';
import { CHILD_TOKEN_HEADER } from '../../src/functions/http/child-token.js';
import { httpFunctionInfo, httpOnRequestFamily } from '../../src/functions/http/discovery.js';
import { spawnFunctionsChild, type FunctionsChildHandle } from '../../src/functions/spawn.js';
import { findUnsupportedTriggers } from '../../src/functions/unsupported.js';
import {
  childModule,
  repoRoot,
  startNodeHostedRuntime,
  type HostedNodeServer,
} from '../functions-identity/hosted-harness.js';

const requireFromConformance = createRequire(
  join(import.meta.dir, '../../../conformance/package.json'),
);
const https = requireFromConformance(
  'firebase-functions/v2/https',
) as typeof import('firebase-functions/v2/https');
const v1 = requireFromConformance('firebase-functions/v1') as typeof import('firebase-functions/v1');

const conformanceEntry = resolve(import.meta.dir, '../../../conformance/package.json');

interface FakeGenkitAction {
  (): undefined;
  __action: { name: string };
  run(
    input: unknown,
    opts?: { context?: Record<string, unknown> },
  ): Promise<{ result: unknown }>;
  stream(
    input: unknown,
    opts?: { context?: Record<string, unknown> },
  ): { stream: AsyncIterable<unknown>; output: Promise<unknown> };
}

function makeFakeAction(
  name: string,
  handlers: {
    run?: FakeGenkitAction['run'];
    stream?: FakeGenkitAction['stream'];
  } = {},
): FakeGenkitAction {
  return Object.assign(() => undefined, {
    __action: { name },
    run: handlers.run ?? (async (input: unknown) => ({ result: { echoed: input } })),
    stream:
      handlers.stream ??
      ((input: unknown) => ({
        stream: (async function* () {
          yield { chunk: 1, input };
          yield { chunk: 2 };
        })(),
        output: Promise.resolve({ done: true, input }),
      })),
  });
}

describe('onCallGenkit discovery', () => {
  test('discovers onCallGenkit with options, nested groups, omit, and coexistence with v1/v2 onCall', () => {
    const summarize = makeFakeAction('summarizeFlow');
    const exported = {
      basic: https.onCallGenkit(summarize as never),
      regional: https.onCallGenkit(
        { region: ['europe-west1', 'us-east1'], timeoutSeconds: 45 },
        summarize as never,
      ),
      ai: {
        nested: https.onCallGenkit({ region: 'asia-northeast1' }, summarize as never),
      },
      omitted: https.onCallGenkit({ omit: true }, summarize as never),
      regularV2: https.onCall(() => 'v2'),
      regularV1: v1.https.onCall(() => 'v1'),
    };

    expect(inspectOnCall(exported).map(httpFunctionInfo)).toEqual([
      {
        exportName: 'basic',
        kind: 'callable',
        regions: ['us-central1'],
        platform: 'gcfv2',
        privateInvoker: false,
        timeoutSeconds: null,
      },
      {
        exportName: 'regional',
        kind: 'callable',
        regions: ['europe-west1', 'us-east1'],
        platform: 'gcfv2',
        privateInvoker: false,
        timeoutSeconds: 45,
      },
      {
        exportName: 'ai-nested',
        kind: 'callable',
        regions: ['asia-northeast1'],
        platform: 'gcfv2',
        privateInvoker: false,
        timeoutSeconds: null,
      },
      {
        exportName: 'regularV2',
        kind: 'callable',
        regions: ['us-central1'],
        platform: 'gcfv2',
        privateInvoker: false,
        timeoutSeconds: null,
      },
      {
        exportName: 'regularV1',
        kind: 'callable',
        regions: ['us-central1'],
        platform: 'gcfv1',
        privateInvoker: false,
        timeoutSeconds: null,
      },
    ]);

    expect(
      findUnsupportedTriggers(exported, [httpOnRequestFamily, callableOnCallFamily]),
    ).toEqual([
      { exportName: 'omitted', eventType: 'callable (omitted from emulation)' },
    ]);

    // Dynamic firebase-functions/params options resolve cleanly on onCallGenkit too.
    const params = requireFromConformance(
      'firebase-functions/params',
    ) as typeof import('firebase-functions/params');
    const dynamicRegion = params.defineString('GENKIT_REGION');
    const dynamicTimeout = params.defineInt('GENKIT_TIMEOUT');
    const dynamicOmit = params.defineBoolean('GENKIT_OMIT');
    const dynamicExported = {
      dyn: https.onCallGenkit(
        { region: dynamicRegion, timeoutSeconds: dynamicTimeout, omit: dynamicOmit },
        summarize as never,
      ),
    };
    expect(
      inspectOnCall(dynamicExported, {
        env: { GENKIT_REGION: 'europe-west4', GENKIT_TIMEOUT: '90', GENKIT_OMIT: 'false' },
      }).map(httpFunctionInfo),
    ).toEqual([
      {
        exportName: 'dyn',
        kind: 'callable',
        regions: ['europe-west4'],
        platform: 'gcfv2',
        privateInvoker: false,
        timeoutSeconds: 90,
      },
    ]);
  });
});

describe('onCallGenkit HTTP child-server execution', () => {
  const servers: HttpChildServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.close();
    }
  });

  test('executes unary, SSE streaming, and HttpsError responses on the HTTP child server', async () => {
    const projectId = 'demo-genkit-http';
    const priorProject = process.env.GCLOUD_PROJECT;
    const priorFirebaseConfig = process.env.FIREBASE_CONFIG;
    process.env.GCLOUD_PROJECT = projectId;
    process.env.FIREBASE_CONFIG = JSON.stringify({ projectId });

    try {
      const summarize = makeFakeAction('summarizeFlow', {
        run: async (input) => {
          const payload = input as { fail?: boolean; text?: string };
          if (payload?.fail) {
            throw new https.HttpsError('permission-denied', 'denied by genkit flow');
          }
          return {
            result: {
              summary: `summary:${payload?.text ?? ''}`,
            },
          };
        },
        stream: (input) => ({
          stream: (async function* () {
            yield { token: 'hel' };
            yield { token: 'lo' };
          })(),
          output: Promise.resolve({
            final: 'hello',
            input,
          }),
        }),
      });

      const exported = {
        summarize: https.onCallGenkit(summarize as never),
      };
      const discovered = inspectOnCall(exported);
      const token = 'test-genkit-child-token';
      const server = await startHttpChildServer(conformanceEntry, discovered, { token });
      servers.push(server);

      const baseUrl = `http://127.0.0.1:${server.port}/`;

      // 1. Unary call.
      const unaryRes = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CHILD_TOKEN_HEADER]: token,
          [FUNCTION_TARGET_HEADER]: 'summarize',
        },
        body: JSON.stringify({ data: { text: 'pyric' } }),
      });
      expect(unaryRes.status).toBe(200);
      expect(await unaryRes.json()).toEqual({
        result: {
          summary: 'summary:pyric',
        },
      });

      // 2. Streaming SSE call.
      const streamRes = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          [CHILD_TOKEN_HEADER]: token,
          [FUNCTION_TARGET_HEADER]: 'summarize',
        },
        body: JSON.stringify({ data: { prompt: 'stream-me' } }),
      });
      expect(streamRes.status).toBe(200);
      const sseBody = await streamRes.text();
      const frames = sseBody
        .split('\n\n')
        .map((frame) => frame.trim())
        .filter((frame) => frame.startsWith('data:'))
        .map((frame) => JSON.parse(frame.slice('data:'.length).trim()) as Record<string, unknown>);
      expect(frames).toEqual([
        { message: { token: 'hel' } },
        { message: { token: 'lo' } },
        { result: { final: 'hello', input: { prompt: 'stream-me' } } },
      ]);

      // 3. HttpsError propagation.
      const errRes = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CHILD_TOKEN_HEADER]: token,
          [FUNCTION_TARGET_HEADER]: 'summarize',
        },
        body: JSON.stringify({ data: { fail: true } }),
      });
      expect(errRes.status).toBe(403);
      expect(await errRes.json()).toEqual({
        error: {
          message: 'denied by genkit flow',
          status: 'PERMISSION_DENIED',
        },
      });
    } finally {
      if (priorProject === undefined) delete process.env.GCLOUD_PROJECT;
      else process.env.GCLOUD_PROJECT = priorProject;
      if (priorFirebaseConfig === undefined) delete process.env.FIREBASE_CONFIG;
      else process.env.FIREBASE_CONFIG = priorFirebaseConfig;
    }
  });
});

describe('onCallGenkit isolated child integration', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  test('mounts onCallGenkit in isolated child with verified auth context, streaming, and omit reporting', async () => {
    const projectId = 'demo-genkit-child';
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-genkit-child-'));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));

    const functionsDir = join(cwd, 'functions');
    mkdirSync(join(cwd, 'public'), { recursive: true });
    mkdirSync(join(functionsDir, 'node_modules'), { recursive: true });
    writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>hosted</body>');
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(functionsDir, 'node_modules/firebase-functions'),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-admin'),
      join(functionsDir, 'node_modules/firebase-admin'),
    );
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
    writeFileSync(
      join(functionsDir, 'package.json'),
      JSON.stringify({ name: 'genkit-child-fixture', private: true, main: 'index.cjs' }),
    );
    writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: projectId } }));

    const entry = join(functionsDir, 'index.cjs');
    writeFileSync(
      entry,
      `const { onCallGenkit, HttpsError } = require('firebase-functions/v2/https');
const flow = Object.assign(() => undefined, {
  __action: { name: 'childEchoFlow' },
  run: async (input, opts) => {
    const auth = opts && opts.context && opts.context.auth;
    if (input && input.requireAuth && !auth) {
      throw new HttpsError('unauthenticated', 'auth required');
    }
    return {
      result: {
        echoed: input,
        uid: auth ? auth.uid : null,
        email: auth && auth.token ? auth.token.email : null,
      },
    };
  },
  stream: (input, opts) => {
    const auth = opts && opts.context && opts.context.auth;
    return {
      stream: (async function* () { yield { step: 1 }; })(),
      output: Promise.resolve({ done: input, uid: auth ? auth.uid : null }),
    };
  },
});
exports.genkitEcho = onCallGenkit({ region: 'us-central1' }, flow);
exports.genkitSkipped = onCallGenkit({ omit: true }, flow);
`,
    );

    const server: HostedNodeServer = await startNodeHostedRuntime(cwd, projectId);
    cleanups.push(() => server.stop());

    const childEnv = buildChildEnv(process.env, {
      serveUrl: server.url,
      registerUrl: registerModuleUrl(),
      instanceId: server.instanceId,
      sessionToken: server.sessionToken,
    });
    const child: FunctionsChildHandle = spawnFunctionsChild({
      cwd: join(cwd, 'functions'),
      entry,
      env: childEnv,
      instance: `${projectId}-default-rtdb`,
      location: 'us-central1',
      projectId,
      childModuleUrl: childModule,
    });
    cleanups.push(() => child.stop());

    const ready = await child.ready;
    expect(ready.http).toBeDefined();
    expect(ready.http?.functions.map((f) => ({ name: f.exportName, kind: f.kind }))).toEqual([
      { name: 'genkitEcho', kind: 'callable' },
    ]);
    expect(ready.unsupportedTriggers).toEqual([
      { exportName: 'genkitSkipped', eventType: 'callable (omitted from emulation)' },
    ]);

    const nowSec = Math.floor(Date.now() / 1000);
    const idToken = mintIdToken({
      iss: `https://securetoken.google.com/${projectId}`,
      aud: projectId,
      auth_time: nowSec,
      user_id: 'genkit-user-1',
      sub: 'genkit-user-1',
      email: 'genkit@example.com',
      iat: nowSec,
      exp: nowSec + 3600,
      firebase: { identities: {}, sign_in_provider: 'password' },
    });

    const baseUrl = `http://127.0.0.1:${ready.http!.port}/`;
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CHILD_TOKEN_HEADER]: ready.http!.token,
        [FUNCTION_TARGET_HEADER]: 'genkitEcho',
        authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ data: { hello: 'genkit', requireAuth: true } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: {
        echoed: { hello: 'genkit', requireAuth: true },
        uid: 'genkit-user-1',
        email: 'genkit@example.com',
      },
    });

    const streamRes = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        [CHILD_TOKEN_HEADER]: ready.http!.token,
        [FUNCTION_TARGET_HEADER]: 'genkitEcho',
        authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ data: { prompt: 'hi' } }),
    });
    expect(streamRes.status).toBe(200);
    const sseText = await streamRes.text();
    const frames = sseText
      .split('\n\n')
      .map((f) => f.trim())
      .filter((f) => f.startsWith('data:'))
      .map((f) => JSON.parse(f.slice('data:'.length).trim()) as Record<string, unknown>);
    expect(frames).toEqual([
      { message: { step: 1 } },
      { result: { done: { prompt: 'hi' }, uid: 'genkit-user-1' } },
    ]);
  }, 30_000);
});
