// #1637: with PYRIC_AI_MODE=production, `pyric sandbox -- next dev` must give
// the page the Firebase SDK's `firebase/ai`, with the `firebase/app` and
// `firebase/app-check` it attaches to, as the Vite plane does. Before the fix
// the banner said "production passthrough" while the page got the sandbox
// `firebase/ai` and its App Check gate.
//
// The page's AI request leaves for firebasevertexai.googleapis.com, and the
// scenario driver's browser guard refuses it: nothing reaches Google. A route
// records the request, with its App Check header, before the guard aborts it.
// The Next and sandbox processes run behind the safety preload of
// `nextjs-firebase-imports.ts`, which keeps every connection on this machine.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Route } from '@playwright/test';
import type { App } from './driver.ts';
import { escapedConnections, nextEnv, PROJECT_ID, readSafetyLog, waitForNext, type ExtraCase, type Safety } from './nextjs-firebase-imports.ts';

const APP_CHECK_TOKEN = 'scenario-custom-app-check-token';
const MODEL = 'gemini-flash-lite-latest';

/** A page that sets up App Check with a custom provider and calls Vertex AI through `firebase/ai`. */
const AI_PAGE = `'use client';
import { useEffect, useState } from 'react';
import { getApps, initializeApp } from 'firebase/app';
import { CustomProvider, initializeAppCheck } from 'firebase/app-check';
import { getAI, getGenerativeModel, VertexAIBackend } from 'firebase/ai';

let model = null;

function setUp() {
  if (model !== null) return model;
  const app = getApps()[0] ?? initializeApp({
    apiKey: 'AIzaSyDemoKeyForReproOnly000000000000',
    projectId: '${PROJECT_ID}',
    appId: '1:123456789012:web:abcdef0123456789',
  });
  initializeAppCheck(app, {
    provider: new CustomProvider({
      getToken: async () => ({ token: '${APP_CHECK_TOKEN}', expireTimeMillis: Date.now() + 3600000 }),
    }),
  });
  model = getGenerativeModel(getAI(app, { backend: new VertexAIBackend('us-central1') }), { model: '${MODEL}' });
  return model;
}

export default function Page() {
  const [status, setStatus] = useState('Loading');
  useEffect(() => {
    const generative = setUp();
    window.runAi = async () => {
      try {
        const result = await generative.generateContent('Reply with one word: pong');
        return { ok: true, text: result.response.text() };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    };
    setStatus('Ready');
  }, []);
  return <p id="ai-status">{status}</p>;
}
`;

interface Outcome { ok: boolean; text?: string; error?: string }
interface Captured { url: URL; appCheck: string | null }
declare function runAi(): Promise<Outcome>;

function writeAiPage(app: App): void {
  const path = 'src/app/ai/page.jsx';
  mkdirSync(dirname(join(app.dir, path)), { recursive: true });
  app.writeFile(path, AI_PAGE);
}

async function runProductionAiCase(app: App, safety: Safety, name: string, nextFlags: readonly string[]): Promise<void> {
  const sandboxPort = await app.freePort();
  const nextPort = await app.freePort();
  const nextUrl = `http://127.0.0.1:${nextPort}`;
  const safetyLog = join(dirname(app.dir), `safety-production-ai-${nextPort}.log`);
  const env = { ...nextEnv(app, safety), SCENARIO_SAFETY_LOG: safetyLog, PYRIC_AI_MODE: 'production' };
  const nextArgs = ['next', 'dev', ...nextFlags, '--port', String(nextPort), '--hostname', '127.0.0.1'];

  const sandbox = await app.step(`${name}: Next serves the app and the banner names production mode`, async () => {
    writeAiPage(app);
    const child = app.pyricProcess(['sandbox', '--no-open', '--port', String(sandboxPort), '--', ...nextArgs], { env });
    await waitForNext(nextUrl, () => child.running);
    assert.match(child.output, /ai\s+production passthrough/);
    return child;
  });

  const captured: Captured[] = [];
  await app.step(`${name}: record Google AI requests before the browser guard refuses them`, async () => {
    const context = await app.browser();
    await context.route('https://firebasevertexai.googleapis.com/**', async (route: Route) => {
      const request = route.request();
      captured.push({ url: new URL(request.url()), appCheck: request.headers()['x-firebase-appcheck'] ?? null });
      await route.fallback();
    });
  });

  const page = await app.step(`${name}: the page sets up App Check and firebase/ai`, async () => {
    const opened = await app.page(`${nextUrl}/ai`);
    await opened.waitForFunction(() => 'runAi' in window, undefined, { timeout: 120_000 });
    return opened;
  });

  await app.step(`${name}: the Firebase SDK sends the request to Vertex AI with the App Check token`, async () => {
    const outcome = await page.evaluate(() => runAi());
    const sent = captured.map((request) => request.url.href);
    assert.equal(captured.length, 1, `requests from the page to Vertex AI: ${sent.join(', ') || 'none'}; the app saw ${JSON.stringify(outcome)}`);
    const [request] = captured;
    assert.match(request!.url.pathname, new RegExp(`/projects/${PROJECT_ID}/locations/us-central1/publishers/google/models/${MODEL}:generateContent$`));
    assert.equal(request!.appCheck, APP_CHECK_TOKEN);
    assert.equal(outcome.ok, false, JSON.stringify(outcome));
    assert.match(outcome.error ?? '', /Error fetching from https:\/\/firebasevertexai\.googleapis\.com\//);
    assert.doesNotMatch(outcome.error ?? '', /projects\/sandbox|deactivated/);
  });

  await app.step(`${name}: the browser guard refused it, the sandbox never answered, and nothing left the machine`, async () => {
    assert.ok(
      app.browserLog.some((line) => line.startsWith('[blocked external request] POST https://firebasevertexai.googleapis.com/')),
      'the browser guard logged no refused Vertex AI request',
    );
    assert.doesNotMatch(sandbox.output, /ai request rejected/);
    assert.deepEqual(escapedConnections(readSafetyLog(safetyLog)), []);
    await page.close();
    await sandbox.stop();
  });
}

/**
 * One production AI mode case per set of `next dev` flags, one per bundler:
 * `[[], ['--webpack']]` on Next 16, whose default is Turbopack, and
 * `[[], ['--turbopack']]` on Next 15, whose default is webpack.
 */
export function productionAiCases(flagSets: ReadonlyArray<readonly string[]>): ExtraCase[] {
  return flagSets.map((nextFlags) => {
    const name = ['PYRIC_AI_MODE=production pyric sandbox -- next dev', ...nextFlags].join(' ');
    return (app, safety) => runProductionAiCase(app, safety, name, nextFlags);
  });
}
