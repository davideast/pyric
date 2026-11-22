import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { deleteApp } from '../../src/app/index.js';
import { createAppForSandbox } from '../../src/app/internal.js';
import type { FirebaseApp } from '../../src/app/types.js';
import { CustomProvider, initializeAppCheck } from '../../src/app-check/index.js';
import {
  APP_CHECK_HINT,
  APP_CHECK_SERVER_HINT,
  admitsAppCheckToken,
  isAppCheckRefusal,
} from '../../src/ai/app-check-gate.js';
import { AiBroker } from '../../src/ai/broker/broker.js';
import { getAI, getGenerativeModel } from '../../src/ai/index.js';
import {
  mintAppCheckToken,
  signAppCheckToken,
} from '../../src/sandbox/internal/app-check-token.js';

const MODEL = 'gemini-flash-lite-latest';
const REQUEST = { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] };
const OPTIONS = {
  apiKey: 'demo-api-key',
  projectId: 'project-alpha',
  appId: '1:123456789012:web:alpha0001',
};

const apps: FirebaseApp[] = [];
const sandboxes: Array<ReturnType<typeof initializeSandbox>> = [];
let seq = 0;

function freshApp(options = OPTIONS): { app: FirebaseApp; sandbox: ReturnType<typeof initializeSandbox> } {
  seq += 1;
  const sandbox = initializeSandbox();
  sandboxes.push(sandbox);
  const app = createAppForSandbox(sandbox, options, `ac-gate-fu-${seq}`);
  apps.push(app);
  return { app, sandbox };
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await deleteApp(app);
  }
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop();
    if (sb !== undefined) sb.dispose();
  }
});

describe('#1656: AI gate checks token audience (projectId) and subject (appId)', () => {
  it('admits matching project/appId and refuses sandbox-signed tokens for another project or appId', async () => {
    const now = Date.now();
    const match = await mintAppCheckToken({ projectId: OPTIONS.projectId, appId: OPTIONS.appId }, 3600, now);
    const otherProject = await mintAppCheckToken({ projectId: 'project-beta', appId: OPTIONS.appId }, 3600, now);
    const otherApp = await mintAppCheckToken(
      { projectId: OPTIONS.projectId, appId: '1:123456789012:web:other9999' },
      3600,
      now,
    );
    const nowSec = Math.floor(now / 1000);
    const nonArrayAud = await signAppCheckToken(
      { alg: 'RS256', kid: 'pyric-sandbox', typ: 'JWT' },
      {
        sub: OPTIONS.appId,
        aud: `projects/${OPTIONS.projectId}`,
        provider: 'pyric-sandbox',
        iss: 'https://firebaseappcheck.googleapis.com/123456789012',
        iat: nowSec,
        exp: nowSec + 3600,
        jti: 'bad-aud-shape',
      },
    );

    const expected = { projectId: OPTIONS.projectId, appId: OPTIONS.appId };
    expect(await admitsAppCheckToken(match.token, now, expected)).toBe(true);
    expect(await admitsAppCheckToken(otherProject.token, now, expected)).toBe(false);
    expect(await admitsAppCheckToken(otherApp.token, now, expected)).toBe(false);
    expect(await admitsAppCheckToken(nonArrayAud, now, expected)).toBe(false);
  });

  it('refuses cross-project and cross-app tokens on generateContent, generateContentStream, and countTokens', async () => {
    const wrongProjectToken = await mintAppCheckToken(
      { projectId: 'other-project', appId: OPTIONS.appId },
      3600,
    );
    const wrongAppToken = await mintAppCheckToken(
      { projectId: OPTIONS.projectId, appId: '1:123456789012:web:wrongapp' },
      3600,
    );

    for (const minted of [wrongProjectToken, wrongAppToken]) {
      const { app } = freshApp();
      initializeAppCheck(app, {
        provider: new CustomProvider({ getToken: async () => minted }),
        isTokenAutoRefreshEnabled: false,
      });
      const model = getGenerativeModel(getAI(app), { model: MODEL });

      let unaryErr: unknown;
      try {
        await model.generateContent('ping');
      } catch (err) {
        unaryErr = err;
      }
      expect(isAppCheckRefusal(unaryErr)).toBe(true);

      let streamErr: unknown;
      try {
        await model.generateContentStream('ping');
      } catch (err) {
        streamErr = err;
      }
      expect(isAppCheckRefusal(streamErr)).toBe(true);

      let countErr: unknown;
      try {
        await model.countTokens('ping');
      } catch (err) {
        countErr = err;
      }
      expect(isAppCheckRefusal(countErr)).toBe(true);
    }
  });

  it('admits a token minted with matching projectId and appId through the broker', async () => {
    const valid = await mintAppCheckToken({ projectId: OPTIONS.projectId, appId: OPTIONS.appId }, 3600);
    const { app } = freshApp();
    initializeAppCheck(app, {
      provider: new CustomProvider({ getToken: async () => valid }),
      isTokenAutoRefreshEnabled: false,
    });
    const model = getGenerativeModel(getAI(app), { model: MODEL });
    const response = await model.generateContent('ping');
    expect(response.response.candidates?.length).toBeGreaterThan(0);
  });
});

describe('#1736: broker request_rejected event carries caller-appropriate App Check hint', () => {
  it('emits APP_CHECK_SERVER_HINT for runtime server and APP_CHECK_HINT for browser or omitted', async () => {
    const sandbox = initializeSandbox();
    sandboxes.push(sandbox);
    const hints: Array<unknown> = [];
    sandbox.onEvent((event) => {
      if (event.kind === 'service_mutation' && event.service === 'ai' && event.op === 'request_rejected') {
        const detail = event.detail as { hint?: unknown } | undefined;
        hints.push(detail?.hint);
      }
    });
    const broker = new AiBroker({ sandbox });

    await broker.generateContent(REQUEST, `models/${MODEL}`, { token: null, runtime: 'server' }).catch(() => {});
    await broker.generateContent(REQUEST, `models/${MODEL}`, { token: null, runtime: 'browser' }).catch(() => {});
    await broker.generateContent(REQUEST, `models/${MODEL}`, { token: null }).catch(() => {});

    expect(hints).toEqual([APP_CHECK_SERVER_HINT, APP_CHECK_HINT, APP_CHECK_HINT]);
  });

  it('emits server hint from getAI(app) in Node and browser hint when document or WorkerGlobalScope is present', async () => {
    const recordHint = async (): Promise<unknown> => {
      const { app, sandbox } = freshApp();
      const hints: unknown[] = [];
      sandbox.onEvent((event) => {
        if (event.kind === 'service_mutation' && event.service === 'ai' && event.op === 'request_rejected') {
          const detail = event.detail as { hint?: unknown } | undefined;
          hints.push(detail?.hint);
        }
      });
      await getGenerativeModel(getAI(app), { model: MODEL }).generateContent('ping').catch(() => {});
      return hints[0];
    };

    expect(await recordHint()).toBe(APP_CHECK_SERVER_HINT);

    const scope = globalThis as { document?: unknown; WorkerGlobalScope?: unknown };
    scope.document = {};
    try {
      expect(await recordHint()).toBe(APP_CHECK_HINT);
    } finally {
      delete scope.document;
    }

    scope.WorkerGlobalScope = class WorkerGlobalScope {};
    try {
      expect(await recordHint()).toBe(APP_CHECK_HINT);
    } finally {
      delete scope.WorkerGlobalScope;
    }
  });

  it('keeps APP_CHECK_SERVER_HINT within the 1024-char diagnostic hint cap', () => {
    expect(APP_CHECK_SERVER_HINT.length).toBeLessThanOrEqual(1024);
    expect(APP_CHECK_SERVER_HINT).not.toContain('self.');
    expect(APP_CHECK_SERVER_HINT).toContain('CustomProvider');
    expect(APP_CHECK_SERVER_HINT).toContain('getAppCheck().createToken(appId)');
    expect(APP_CHECK_SERVER_HINT.endsWith('https://firebase.google.com/docs/ai-logic/app-check')).toBe(true);
  });
});
