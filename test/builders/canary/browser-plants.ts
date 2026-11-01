/**
 * The canary's browser plants, run under Node (Playwright's `connect` fails
 * under Bun) with the recorder in NODE_OPTIONS, the way a builder's own
 * Playwright script runs. It connects to the harness browser, opens the canary
 * page, and plants a fetch, an image, a WebSocket and a service-worker fetch
 * toward Google hosts and the metadata server. Prints one JSON line:
 * { preflight, plants: [{ name, url, outcome }], local: { url, outcome } }.
 *
 * Before planting anything it checks the browser's resolver rules: a fetch to
 * a server it runs on 127.0.0.2 must fail without reaching it. If it reaches
 * it, the rules are not in effect, and it exits 3 having planted nothing.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from '@playwright/test';

interface CanaryPage {
  config: { projectId: string; apiKey: string };
  fetchOutcome(url: string): Promise<string>;
  imageOutcome(url: string): Promise<string>;
  webSocketOutcome(url: string): Promise<string>;
  serviceWorkerFetchOutcome(url: string): Promise<string>;
}

declare const canary: CanaryPage;

type Primitive = 'fetchOutcome' | 'imageOutcome' | 'webSocketOutcome' | 'serviceWorkerFetchOutcome';

interface Plant {
  name: string;
  url: string;
  primitive: Primitive;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** A server on 127.0.0.2 that counts the requests that reach it. */
async function startPreflightServer(): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.setHeader('access-control-allow-origin', '*');
    response.end('the resolver rules let this through');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.2', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.2:${port}/preflight`, hits: () => hits };
}

function plantsFor(config: CanaryPage['config']): Plant[] {
  const project = config.projectId;
  const database = `${project}-default-rtdb`;
  return [
    { name: 'page fetch to Cloud Firestore', primitive: 'fetchOutcome', url: `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/canary/a` },
    { name: 'page fetch to the metadata server', primitive: 'fetchOutcome', url: 'http://169.254.169.254/computeMetadata/v1/' },
    { name: 'image from a Google host the catalog does not list', primitive: 'imageOutcome', url: 'https://www.gstatic.com/firebasejs/canary.png' },
    { name: 'WebSocket to the Realtime Database', primitive: 'webSocketOutcome', url: `wss://${database}.firebaseio.com/.ws?v=5&ns=${database}` },
    { name: 'service-worker fetch to Firebase Authentication', primitive: 'serviceWorkerFetchOutcome', url: `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${config.apiKey}` },
  ];
}

function runPrimitive(page: Page, primitive: Primitive, url: string): Promise<string> {
  return page.evaluate(([name, target]) => canary[name](target), [primitive, url] as const);
}

async function main(): Promise<void> {
  const browser = await chromium.connect(required('PYRIC_BUILDER_BROWSER_WS'));
  const appUrl = required('CANARY_APP_URL');
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(appUrl);
  await page.waitForFunction(() => 'canary' in window);

  const preflightServer = await startPreflightServer();
  const preflightOutcome = await runPrimitive(page, 'fetchOutcome', preflightServer.url);
  const preflight = { url: preflightServer.url, outcome: preflightOutcome, reached: preflightServer.hits() };
  preflightServer.server.close();
  const rulesHold = preflight.reached === 0 && preflight.outcome.startsWith('failed');
  if (!rulesHold) {
    console.log(JSON.stringify({ preflight, plants: [], local: null }));
    await browser.close();
    process.exit(3);
  }

  const config = await page.evaluate(() => canary.config);
  const plants = [];
  for (const plant of plantsFor(config)) {
    plants.push({ name: plant.name, url: plant.url, outcome: await runPrimitive(page, plant.primitive, plant.url) });
  }
  const localUrl = new URL('/local.txt', appUrl).href;
  const local = { url: localUrl, outcome: await runPrimitive(page, 'fetchOutcome', localUrl) };
  console.log(JSON.stringify({ preflight, plants, local }));
  await browser.close();
}

await main();
