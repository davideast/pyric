import { expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import type { LiveBackend } from './fixture.js';

export async function expectLiveRead(
  context: BrowserContext,
  request: APIRequestContext,
  url: string,
  backend: LiveBackend,
): Promise<void> {
  const allowedOrigins = new Set([
    new URL(url).origin,
    backend.authUrl,
    `http://127.0.0.1:${backend.firestorePort}`,
  ]);
  await context.route('**/*', (route) => {
    const origin = new URL(route.request().url()).origin;
    const isTestBackend = allowedOrigins.has(origin);
    if (isTestBackend) return route.continue();
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('Live fixture:', error.message));
  await page.goto(url);
  await expect(page.locator('#result')).toHaveText('Read by real Firebase');

  const initResponse = await request.get(`${url}/__pyric/init.json`);
  const init: { sessionToken: string } = await initResponse.json();
  await expect.poll(async () => {
    const captureResponse = await request.get(`${url}/__pyric/capture`, {
      headers: { 'x-pyric-session-token': init.sessionToken },
    });
    const isMissingCapture = !captureResponse.ok();
    if (isMissingCapture) return [];
    const capture: { events: Array<{ kind: string; detail?: { live?: boolean } }> } = await captureResponse.json();
    return capture.events.filter((event) => {
      const isRead = event.kind === 'request';
      const isLive = event.detail?.live === true;
      return isRead && isLive;
    });
  }).toEqual([expect.objectContaining({
    kind: 'request',
    method: 'get',
    path: 'proofs/identity',
    auth: expect.objectContaining({ uid: backend.uid }),
    rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
    detail: expect.objectContaining({ live: true, source: 'server', hasPendingWrites: false }),
  })]);
}
