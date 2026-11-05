// Editing vite.config.js restarts Vite's dev server. Vite builds the
// replacement, which evaluates the config and calls pyric() again, before it
// closes the old server. The restart must succeed, apply the edit, and keep
// the hosted state.
//
// The app's own browser routes every request through `guardContext`, and
// Playwright turns the HTTP cache off in a context with a route. A second
// browser here has the cache on: it blocks other hosts with the driver's
// Chromium resolver rules alone, and has no route. Its page reloads across
// the restart with the cache on (in local runs `main.js` and Vite's
// `env.mjs` came back as 304s), and must run the new host generation's Pyric
// app module, not a copy the cache held from the old one.
//
// That browser's first step is the proof that the resolver rules alone keep
// it on this machine. A listener on every local address answers any request,
// and the page and a dedicated worker each try a fetch and a WebSocket to it
// under names and addresses the rules do not exclude. Without the rules each
// of those reached the listener (checked by hand with Playwright 1.62.0); with
// them only the 127.0.0.1 control does.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserContext, Page } from '@playwright/test';
import { launchScenarioBrowser, scenario, type App } from '../driver.ts';

declare const notes: { write(text: string): Promise<void>; read(): Promise<unknown> };
/** What Pyric's runtime puts on a page's global object: the HTML stamps the init, and the app module its own generation. */
type PyricGlobals = { __PYRIC_WORKER_INIT__?: { instanceId?: string }; __PYRIC_HOST_INSTANCE_ID__?: string };

/** Hosts the resolver rules must refuse, each of which reaches a listener on every local address without them. */
const REFUSED_HOSTS = ['127.0.0.2', 'blocked.localhost', '[::ffff:127.0.0.2]', '0.0.0.0', '2130706434', '0x7f000002', 'localhost.'];
const CONTROL_HOST = '127.0.0.1';

/** Tries a fetch and a WebSocket to each host, from the page and from a dedicated worker. */
const PROBE = `async (hosts, port) => {
  const tries = (hosts, port) => Promise.all(hosts.flatMap((host) => [
    fetch('http://' + host + ':' + port + '/fetch', { mode: 'no-cors' }).then(() => 'reached', () => 'refused'),
    new Promise((resolve) => {
      const socket = new WebSocket('ws://' + host + ':' + port + '/socket');
      socket.onopen = () => { socket.close(); resolve('reached'); };
      socket.onerror = () => resolve('refused');
      setTimeout(() => resolve('no answer in 5s'), 5000);
    }),
  ]));
  const source = 'onmessage = (event) => (' + tries + ')(...event.data).then((outcomes) => postMessage(outcomes));';
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  const fromWorker = new Promise((resolve) => { worker.onmessage = (event) => resolve(event.data); });
  worker.postMessage([hosts, port]);
  return { page: await tries(hosts, port), worker: await fromWorker };
}`;

/** Every request the listener received, as `<Host header> <path>`, while `run` ran. */
async function listenOnEveryLocalAddress<T>(run: (port: number) => Promise<T>): Promise<string[]> {
  const seen: string[] = [];
  const listener = createServer((request, response) => {
    seen.push(`${request.headers.host} ${request.url}`);
    response.end('ok');
  });
  listener.on('upgrade', (request, socket) => {
    seen.push(`${request.headers.host} ${request.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => listener.listen(0, '::', resolve));
  try {
    await run((listener.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
  return seen;
}

/** Opens `url` in the cache-on context, with its error responses counted as the app's own pages' are. */
async function openCached(app: App, context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  page.on('response', (response) => {
    if (response.status() < 400) return;
    (app.browserLog as string[]).push(`[cached page response ${response.status()}] ${response.request().method()} ${response.url()}`);
    app.noteErrorResponse(response.status(), response.request().method(), response.url());
  });
  await page.goto(url);
  await page.waitForFunction(() => 'notes' in window);
  return page;
}

/** The URLs `page` loads from the HTTP cache, or revalidates with a 304, from now on. */
async function cacheHits(context: BrowserContext, page: Page): Promise<Set<string>> {
  const hits = new Set<string>();
  const urls = new Map<string, string>();
  const session = await context.newCDPSession(page);
  session.on('Network.requestWillBeSent', (event) => urls.set(event.requestId, event.request.url));
  session.on('Network.requestServedFromCache', (event) => hits.add(urls.get(event.requestId) ?? event.requestId));
  session.on('Network.responseReceived', (event) => {
    const isFromCache = event.response.fromDiskCache === true || event.response.status === 304;
    if (isFromCache) hits.add(event.response.url);
  });
  await session.send('Network.enable');
  return hits;
}

/** The host generation the page's HTML names, and the one Pyric's app module, which the cache may hold, was served for. */
function pageGenerations(page: Page): Promise<{ html: string | undefined; module: string | undefined }> {
  return page.evaluate(() => {
    const pyric = globalThis as PyricGlobals;
    return { html: pyric.__PYRIC_WORKER_INIT__?.instanceId, module: pyric.__PYRIC_HOST_INSTANCE_ID__ };
  });
}

async function hostInstance(url: string): Promise<string> {
  const health = await (await fetch(`${url}/__pyric/health`)).json() as { instanceId?: string };
  assert.ok(health.instanceId, `/__pyric/health has no instanceId: ${JSON.stringify(health)}`);
  return health.instanceId;
}

/** Settles `pending` within `ms`, or fails naming the browser call that never settled. */
function within<T>(call: string, ms: number, pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${call} did not settle within ${ms / 1000}s`)), ms);
  });
  return Promise.race([pending, stuck]).finally(() => clearTimeout(timer));
}

export default scenario(async (app) => {
  // The restart interrupts the page's connection, and the page posts that to
  // /__pyric/diagnostics. A post made before the new server generation mounts
  // Pyric's routes answers 404, and the page keeps the report in memory.
  // Whether a post lands that early is a race, so some runs see none (#2098).
  app.expectHostError(/^404 POST \/__pyric\/diagnostics$/, { mayNotHappen: 'a race decides whether the post lands before the new routes mount (#2098)' });

  const host = await app.step('start the hosted dev server', () => app.devServer());

  const page = await app.step('write a note from the page', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'notes' in window);
    await page.evaluate(() => notes.write('before restart'));
    return page;
  });

  await app.step('the page console says the sandbox runs on the dev server', async () => {
    const tab = await (await app.browser()).newPage();
    const line = tab.waitForEvent('console', { predicate: (message) => message.text().startsWith('[pyric sandbox] firebase/*'), timeout: 15_000 });
    await tab.goto(host.url);
    const text = (await line).text();
    await tab.close();
    assert.match(text, /on the dev server/, text);
    assert.doesNotMatch(text, /SharedWorker/, text);
  });

  const before = await app.step('read the host instance', () => hostInstance(host.url));

  // Resolver rules only, no route, so the HTTP cache stays on.
  const cachedBrowser = await launchScenarioBrowser();
  try {
    const cachedContext = await cachedBrowser.newContext();
    await app.watchCrashes(cachedContext);

    await app.step('the resolver rules alone keep the cache-on browser on loopback', async () => {
      const page = await openCached(app, cachedContext, host.url);
      let outcomes: { page: string[]; worker: string[] } = { page: [], worker: [] };
      const seen = await listenOnEveryLocalAddress(async (port) => {
        outcomes = await page.evaluate(`(${PROBE})(${JSON.stringify([...REFUSED_HOSTS, CONTROL_HOST])}, ${port})`);
      });
      const tried = [...REFUSED_HOSTS, CONTROL_HOST].flatMap((name) => [`fetch ${name}`, `WebSocket ${name}`]);
      const control = tried.slice(-2);
      for (const [where, results] of Object.entries(outcomes)) {
        const reached = tried.filter((_, index) => results[index] === 'reached');
        assert.deepEqual(reached, control.slice(0, 1), `from the ${where}, only the control fetch reaches the listener (the listener refuses every WebSocket upgrade)`);
      }
      assert.ok(seen.length >= 4, `the controls did not reach the listener: ${JSON.stringify(seen)}`);
      const escaped = seen.filter((line) => !line.startsWith(`${CONTROL_HOST}:`));
      assert.deepEqual(escaped, [], 'a request under a name or address the rules refuse reached the listener');
      await page.close();
    });

    const cached = await app.step('a page in the cache-on browser loads its modules from the cache on a reload', async () => {
      const page = await openCached(app, cachedContext, host.url);
      const hits = await cacheHits(cachedContext, page);
      await page.reload();
      await page.waitForFunction(() => 'notes' in window);
      assert.ok(hits.size > 0, 'no request came from the HTTP cache, so the cache is off and the restart below tests nothing');
      assert.deepEqual(await pageGenerations(page), { html: before, module: before });
      hits.clear();
      return { page, hits };
    });

    // Vite's client reloads the open page once the restarted server answers.
    // Playwright's page.close() can hang for good when it lands while a page
    // reloads, so the scenario waits for that reload and reads from the
    // reloaded page instead of closing it.
    let reloaded: Promise<unknown> = Promise.resolve();
    let cachedReloaded: Promise<unknown> = Promise.resolve();
    await app.step('edit vite.config.js; Vite restarts the server', async () => {
      const mark = host.process.mark();
      reloaded = page.waitForEvent('load', { timeout: 90_000 });
      cachedReloaded = cached.page.waitForEvent('load', { timeout: 90_000 });
      // The last steps await the reloads; this keeps a failure before then from going unhandled.
      reloaded.catch(() => {});
      cachedReloaded.catch(() => {});
      const config = app.readFile('vite.config.js');
      const edited = config.replace(
        'server: { port: 5181, strictPort: true },',
        'server: { port: 5181, strictPort: true, headers: { "x-config-revision": "2" } },',
      );
      assert.notEqual(edited, config, 'the edit did not apply to vite.config.js');
      app.writeFile('vite.config.js', edited);
      const [outcome] = await host.process.waitForLog(/server restarted|server restart failed/, { since: mark, timeoutMs: 60_000 });
      assert.equal(outcome, 'server restarted', `Vite reported: ${host.process.output.slice(mark).trim()}`);
    });

    await app.step('the restarted server runs the edited config on a new host generation', async () => {
      const response = await fetch(`${host.url}/`);
      assert.equal(response.headers.get('x-config-revision'), '2');
      assert.notEqual(await hostInstance(host.url), before);
    });

    await app.step('the note written before the restart reads back after it', async () => {
      await reloaded;
      await page.waitForFunction(() => 'notes' in window, undefined, { timeout: 30_000 });
      const note = await within('page.evaluate(() => notes.read())', 30_000, page.evaluate(() => notes.read()));
      assert.equal(note, 'before restart');
    });

    await app.step('the cache-on page reloads onto the new generation, with no stale runtime module', async () => {
      await cachedReloaded;
      await cached.page.waitForFunction(() => 'notes' in window, undefined, { timeout: 30_000 });
      const after = await hostInstance(host.url);
      assert.ok(cached.hits.size > 0, 'the reload after the restart took nothing from the HTTP cache, so it tests nothing');
      console.log(`  hosted-dev-server-restart: the cache-on reload took ${cached.hits.size} responses from the HTTP cache or a 304: ${[...cached.hits].join(', ')}`);
      assert.deepEqual(
        await pageGenerations(cached.page),
        { html: after, module: after },
        `the page ran a Pyric app module served for generation ${before}; it came from the cache: ${[...cached.hits].join(', ')}`,
      );
      const note = await within('cached page notes.read()', 30_000, cached.page.evaluate(() => notes.read()));
      assert.equal(note, 'before restart');
    });
  } finally {
    await cachedBrowser.close();
  }
});
