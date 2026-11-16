import { afterEach, describe, expect, it } from 'bun:test';
import { getClock, initializeSandbox } from 'pyric/sandbox';
import { mintAppCheckToken } from '../../src/sandbox/internal/app-check-token.js';
import { deleteApp } from '../../src/app/index.js';
import { createAppForSandbox } from '../../src/app/internal.js';
import type { FirebaseApp } from '../../src/app/types.js';
import { CustomProvider, initializeAppCheck } from '../../src/app-check/index.js';
import { getAI, getGenerativeModel } from '../../src/ai/index.js';
import { script } from '../../src/ai/scripting.js';
import { AiBroker } from '../../src/ai/broker/broker.js';
import { isAppCheckRefusal } from '../../src/ai/app-check-gate.js';

const BASE_CONFIG = {
  projectId: 'proj-clock-check',
  appId: '1:100001:web:clock1',
  apiKey: 'synthetic-clock-api-key',
};

const apps: FirebaseApp[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app !== undefined) {
      await deleteApp(app);
    }
  }
});

function decodeExpMillis(token: string): number {
  const payload = token.split('.')[1];
  if (payload === undefined) throw new Error('expected JWT payload segment');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp: number };
  return claims.exp * 1000;
}

describe('AI broker App Check virtual clock enforcement', () => {
  it('refuses requests across generateContent, generateContentStream, and countTokens once sandbox clock advances past token exp', async () => {
    const sandbox = initializeSandbox();
    const app = createAppForSandbox(sandbox, BASE_CONFIG, 'ai-clock-advance');
    apps.push(app);

    const minted = await mintAppCheckToken(
      { appId: BASE_CONFIG.appId, projectId: BASE_CONFIG.projectId },
      30 * 60,
      getClock(sandbox).now(),
    );
    const expMillis = decodeExpMillis(minted.token);

    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => ({ token: minted.token, expireTimeMillis: 0 }),
      }),
    });
    const ai = getAI(app);
    script(ai, [
      { respond: { text: 'before-expiry' } },
      { respond: { text: 'stream-before-expiry' } },
      { respond: { text: 'after-reset' } },
    ]);
    const model = getGenerativeModel(ai, { model: 'gemini-2.5-flash' });

    const beforeUnary = await model.generateContent('turn 1');
    expect(beforeUnary.response.text()).toBe('before-expiry');

    const beforeStream = await model.generateContentStream('turn 2');
    const beforeStreamAgg = await beforeStream.response;
    expect(beforeStreamAgg.text()).toBe('stream-before-expiry');

    const beforeCount = await model.countTokens('turn 3');
    expect(beforeCount.totalTokens).toBeGreaterThan(0);

    // Advance virtual clock 2 hours past the 30-minute token expiry.
    getClock(sandbox).advance(2 * 60 * 60 * 1000);
    expect(getClock(sandbox).now()).toBeGreaterThan(expMillis);

    let unaryError: unknown;
    try {
      await model.generateContent('after expiry');
    } catch (err) {
      unaryError = err;
    }
    expect(isAppCheckRefusal(unaryError)).toBe(true);

    let streamError: unknown;
    try {
      const streamResult = await model.generateContentStream('after expiry stream');
      for await (const _chunk of streamResult.stream) {
        // Should throw before yielding any chunk.
      }
    } catch (err) {
      streamError = err;
    }
    expect(isAppCheckRefusal(streamError)).toBe(true);

    let countError: unknown;
    try {
      await model.countTokens('after expiry count');
    } catch (err) {
      countError = err;
    }
    expect(isAppCheckRefusal(countError)).toBe(true);

    const rejectedEvents = sandbox
      .history()
      .filter(
        (event) =>
          event.kind === 'service_mutation' &&
          event.service === 'ai' &&
          event.op === 'request_rejected',
      );
    expect(rejectedEvents.length).toBeGreaterThanOrEqual(3);
    const latestRejection = rejectedEvents[rejectedEvents.length - 1];
    expect(latestRejection?.at).toBeGreaterThan(expMillis);

    // Resetting the virtual clock back before token exp re-admits the token.
    getClock(sandbox).reset();
    const afterReset = await model.generateContent('after clock reset');
    expect(afterReset.response.text()).toBe('after-reset');
  });

  it('enforces exact exp millisecond boundary using sandbox clock set()', async () => {
    const sandbox = initializeSandbox();
    const broker = new AiBroker({ sandbox });
    const minted = await mintAppCheckToken(
      { appId: BASE_CONFIG.appId, projectId: BASE_CONFIG.projectId },
      600,
      getClock(sandbox).now(),
    );
    const expMillis = decodeExpMillis(minted.token);
    const clock = getClock(sandbox);
    const req = { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] };

    // 1 ms before exp is still valid.
    clock.set(expMillis - 1);
    const validRes = await broker.generateContent(req, 'models/gemini-2.5-flash', { token: minted.token });
    expect(validRes.candidates?.length).toBeGreaterThan(0);

    // At exact exp (exp * 1000 === nowMillis), expiresAfter requires strictly greater than nowMillis.
    clock.set(expMillis);
    let atExpError: unknown;
    try {
      await broker.generateContent(req, 'models/gemini-2.5-flash', { token: minted.token });
    } catch (err) {
      atExpError = err;
    }
    expect(isAppCheckRefusal(atExpError)).toBe(true);
  });

  it('falls back to wall clock when AiBroker is instantiated without a sandbox', async () => {
    const broker = new AiBroker();
    const minted = await mintAppCheckToken(
      { appId: BASE_CONFIG.appId, projectId: BASE_CONFIG.projectId },
      600,
    );
    const req = { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] };
    const response = await broker.generateContent(req, 'models/gemini-2.5-flash', { token: minted.token });
    expect(response.candidates?.length).toBeGreaterThan(0);

    const expired = await mintAppCheckToken(
      { appId: BASE_CONFIG.appId, projectId: BASE_CONFIG.projectId },
      0,
      Date.now() - 5000,
    );
    let expiredError: unknown;
    try {
      await broker.generateContent(req, 'models/gemini-2.5-flash', { token: expired.token });
    } catch (err) {
      expiredError = err;
    }
    expect(isAppCheckRefusal(expiredError)).toBe(true);
  });
});
