/**
 * Live mode captures bounded in-memory session data from firebase-admin
 * Firestore and Realtime Database calls made by a Node server under
 * `node --import @pyric/live/register`, surfaces SDK provenance in Studio's
 * Data and Realtime Database views (`Observed · Admin` and
 * `Observed · Client + Admin`), strips values from Traffic events and terminal
 * output, and writes nothing to `.pyric/` unless explicitly seeded.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scenario, sleep, type App, type ExpectedCrash } from '../driver.ts';
import { buildRecording, INSTANCE, PROJECT, SECRET_VALUE } from './recording.ts';

const RECORDING_FILE = 'session-recording.json';
const HOSTED_STATE = '.pyric/state/hosted';

const NODE_VERSION = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim();
const ADMIN_ROWS_ON = Number(NODE_VERSION.split('.')[0]) >= 23;

function expectedCrashesForNode(): ExpectedCrash[] {
  if (ADMIN_ROWS_ON) return [];
  return [
    {
      message:
        /^Error: @pyric\/live: firebase-admin\/app \(the Admin SDK\) is refused in live mode\. @pyric\/live observes firebase-admin on Node 23 or later/,
      source: /^command \d+ \(node --import @pyric\/live\/register server\.mjs\)$/,
      reason:
        'on Node 22, whose require() skips the hooks, the Admin rows stay shut and the job is refused its import',
    },
  ];
}

export const expectedCrashes: ExpectedCrash[] = expectedCrashesForNode();

declare function readCatalogItem(): Promise<Record<string, unknown> | string | null>;

interface Replay {
  origin: string;
  grpc: string;
  unmatched(): Promise<unknown[]>;
}

async function startReplay(app: App): Promise<Replay> {
  const { FORMAT } = await import('../replay/format.ts');
  app.writeFile(RECORDING_FILE, `${JSON.stringify(buildRecording(FORMAT))}\n`);
  const { replayServerArgs, endpointsIn, unmatchedBy } = await import('../replay/process.ts');
  const server = app.commandProcess('node', replayServerArgs([`${app.dir}/${RECORDING_FILE}`], app.dir));
  await server.waitForLog(/^REPLAY \{/m, { timeoutMs: 30_000 });
  const endpoints = endpointsIn(server.output);
  assert.ok(endpoints?.grpc, `the replay server named no gRPC host:\n${server.output}`);
  return {
    origin: endpoints.origin,
    grpc: endpoints.grpc,
    unmatched: () => unmatchedBy(endpoints.origin),
  };
}

function jobEnv(replay: Replay): Record<string, string> {
  const host = new URL(replay.origin).host;
  return {
    ORDERS_PROJECT: PROJECT,
    FIRESTORE_EMULATOR_HOST: replay.grpc,
    FIREBASE_DATABASE_EMULATOR_HOST: host,
  };
}

interface JobResult {
  results: Record<string, string>;
  addedId: string;
  pushedKey: string;
}

function resultOf(output: string): JobResult {
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `no RESULT line:\n${output}`);
  return JSON.parse(line.slice('RESULT '.length)) as JobResult;
}

interface SessionSnapshot {
  revision: number;
  projectId: string;
  firestore: Record<string, Record<string, unknown>>;
  rtdb: Record<string, unknown>;
  defaultRtdbInstance: string | null;
  sources?: { client: boolean; admin: boolean };
  skips?: {
    oversized: number;
    unsupported: number;
    truncated: number;
    failed: number;
    admin: number;
  };
}

async function hostJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} answered ${response.status}`);
  return (await response.json()) as T;
}

async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`${what}: still ${JSON.stringify(value, null, 2)} after ${timeoutMs / 1000}s`);
    }
    await sleep(250);
  }
}

interface CapturedEvent {
  kind?: string;
  detail?: { sdk?: string };
}

async function adminCaptureEvents(base: string): Promise<{ raw: string; events: CapturedEvent[] }> {
  const { sessionToken } = await hostJson<{ sessionToken: string }>(`${base}/__pyric/init.json`);
  const response = await fetch(`${base}/__pyric/capture`, {
    headers: { 'x-pyric-session-token': sessionToken },
  });
  if (response.status === 404) return { raw: '', events: [] };
  assert.equal(response.status, 200, `/__pyric/capture answered ${response.status}`);
  const raw = await response.text();
  const parsed = JSON.parse(raw) as { events?: CapturedEvent[] };
  const events = (parsed.events ?? []).filter((e) => e.kind === 'operation' && e.detail?.sdk === 'admin');
  return { raw, events };
}

const STUDIO_FONT_HOSTS = ['https://use.typekit.net/', 'https://fonts.googleapis.com/'];

function isStudioFont(line: string): boolean {
  return STUDIO_FONT_HOSTS.some((host) => line.includes(` ${host}`));
}

function blockedLines(app: App): string[] {
  return app.browserLog.filter((line) => line.includes('[blocked external') && !isStudioFont(line));
}

function hostedStateText(app: App): string {
  const root = join(app.dir, HOSTED_STATE);
  if (!existsSync(root)) return '';
  const texts: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else texts.push(readFileSync(path, 'latin1'));
    }
  };
  walk(root);
  return texts.join('\n');
}

function assertNoObservedValuesInHostedState(app: App, markers: readonly string[]): void {
  const text = hostedStateText(app);
  for (const marker of markers) {
    assert.equal(text.includes(marker), false, `${HOSTED_STATE} persisted ${marker} without developer confirmation`);
  }
}

export default scenario(async (app) => {
  app.writeFile('.firebaserc', `${JSON.stringify({ projects: { default: PROJECT } })}\n`);
  const replay = await app.step('start the offline replay server', () => startReplay(app));

  const host = await app.step('start vite dev with pyricLive()', async () => {
    const started = await app.devServer();
    await started.process.waitForLog(
      new RegExp(`@pyric/live/vite: live mode for the Firebase project ${PROJECT}\\.`),
    );
    return started;
  });

  if (!ADMIN_ROWS_ON) {
    await app.step(`on Node ${NODE_VERSION}, firebase-admin is refused naming Node 23`, async () => {
      const run = await app.command('node', ['--import', '@pyric/live/register', 'server.mjs'], {
        env: jobEnv(replay),
        timeoutMs: 120_000,
      });
      assert.notEqual(run.code, 0, run.output);
      assert.match(
        run.output,
        /@pyric\/live\/register: firebase-admin is refused in this process\. @pyric\/live observes firebase-admin on Node 23 or later/,
      );
      await host.process.stop();
    });
    return;
  }

  const jobOutcome = await app.step(
    'run the Node backend under @pyric/live/register with firebase-admin Firestore and RTDB calls',
    async () => {
      const run = await app.command('node', ['--import', '@pyric/live/register', 'server.mjs'], {
        env: jobEnv(replay),
        timeoutMs: 120_000,
      });
      assert.equal(run.code, 0, run.output);
      assert.deepEqual(await replay.unmatched(), [], `unmatched replay requests:\n${run.output}`);
      const parsed = resultOf(run.output);
      assert.deepEqual(parsed.results, {
        'firestore.set': 'ok',
        'firestore.get': 'ok',
        'firestore.get-missing': 'ok',
        'firestore.create': 'ok',
        'firestore.merge': 'ok',
        'firestore.delete': 'ok',
        'firestore.update': 'ok',
        'firestore.update-missing': '5',
        'firestore.add': 'ok',
        'firestore.getAll': 'ok',
        'firestore.batch': 'ok',
        'firestore.query': 'ok',
        'firestore.onSnapshot': 'ok',
        'firestore.tx-commit': 'ok',
        'firestore.select': 'ok',
        'firestore.tx-rollback': 'abort-tx',
        'rtdb.set': 'ok',
        'rtdb.update': 'ok',
        'rtdb.setWithPriority': 'ok',
        'rtdb.remove': 'ok',
        'rtdb.push': 'ok',
        'rtdb.get': 'ok',
        'rtdb.filtered-get': 'ok',
        'rtdb.once': 'ok',
        'rtdb.on': 'ok',
        'rtdb.tx-commit': 'ok',
        'rtdb.tx-abort': 'ok',
      });
      assert.ok(parsed.addedId.length > 0, 'expected added Firestore document id');
      assert.ok(parsed.pushedKey.length > 0, 'expected pushed RTDB child key');
      return { output: run.output, ...parsed };
    },
  );

  await app.step(
    'session-data holds Admin Firestore docs and RTDB trees with sources.admin=true, skips.admin=0, value-free Traffic/logs, and zero .pyric/ disk writes',
    async () => {
      const snapshot = await eventually(
        () => hostJson<SessionSnapshot>(`${host.url}/__pyric/live/session-data`),
        (snap) => Object.keys(snap.firestore).length >= 9 && INSTANCE in snap.rtdb,
        'Admin session-data snapshot',
      );

      assert.deepEqual(snapshot.sources, { client: false, admin: true });
      assert.equal(snapshot.skips?.admin ?? 0, 0, `expected skips.admin === 0: ${JSON.stringify(snapshot.skips)}`);
      assert.equal(snapshot.skips?.unsupported, 1, 'projected Query.select() read counts as unsupported');
      assert.equal(snapshot.skips?.failed, 2, 'failed update and rolled-back transaction count as failed skips');

      assert.deepEqual(snapshot.firestore['orders/ord-1'], {
        apiKey: SECRET_VALUE,
        previousStatus: 'processing',
        priority: 2,
        status: 'fulfilled',
        total: 42,
      });
      assert.deepEqual(snapshot.firestore['orders/ord-created'], {
        status: 'created',
        total: 12,
      });
      assert.deepEqual(snapshot.firestore['orders/ord-merge'], {
        status: 'merged',
        tier: 'gold',
        total: 20,
      });
      assert.deepEqual(snapshot.firestore['orders/ord-2'], {
        status: 'shipped',
        total: 80,
      });
      assert.deepEqual(snapshot.firestore[`orders/${jobOutcome.addedId}`], {
        status: 'added',
        total: 15,
      });
      assert.deepEqual(snapshot.firestore['orders/ord-batch'], {
        status: 'batched',
        total: 10,
      });
      assert.deepEqual(snapshot.firestore['orders/ord-extra'], {
        status: 'indexed',
        total: 30,
      });
      assert.deepEqual(snapshot.firestore['orders/ord-live-1'], {
        status: 'live',
        total: 25,
      });
      assert.deepEqual(snapshot.firestore['orders/ord-live-2'], {
        status: 'live',
        total: 35,
      });
      assert.equal('orders/ord-temp' in snapshot.firestore, false);
      assert.equal('orders/ord-missing' in snapshot.firestore, false);
      assert.equal('orders/ord-stale' in snapshot.firestore, false);

      assert.deepEqual(snapshot.rtdb[INSTANCE], {
        queues: {
          'q-1': { region: 'us', state: 'ready', workers: 3 },
          'priority-q': { state: 'prio' },
          items: { [jobOutcome.pushedKey]: { job: 'sync' } },
          extra: { state: 'loaded' },
          'by-region': {
            east: { region: 'east' },
            west: { region: 'synced-west' },
          },
          'once-q': { state: 'once-read' },
          'watch-q': { step: 2 },
        },
        counters: {
          processed: 5,
        },
      });

      const captured = await eventually(
        () => adminCaptureEvents(host.url),
        (c) => c.events.length >= 28,
        'Admin capture events',
      );
      assert.equal(captured.raw.includes(SECRET_VALUE), false, 'capture events leaked secret value');
      assert.equal(captured.raw.includes('fulfilled'), false, 'capture events leaked Admin document field value');
      assert.equal(jobOutcome.output.includes(SECRET_VALUE), false, 'terminal output leaked secret value');

      assertNoObservedValuesInHostedState(app, [SECRET_VALUE, 'fulfilled', 'ord-1', 'q-1']);
    },
  );

  await app.step(
    'Studio Data and RTDB views render Admin-captured state read-only with Observed · Admin provenance',
    async () => {
      const studio = await app.page(`${host.url}/__pyric/ui/firestore/orders/ord-1`);
      await studio.locator('[data-live-observed-badge]').waitFor({ timeout: 30_000 });
      await eventually(
        async () => (await studio.locator('[data-live-observed-badge]').textContent()) ?? '',
        (badge) => badge.includes('Observed · Admin · Partial · Read-only'),
        'Observed · Admin badge in Studio Data view',
      );
      await eventually(
        async () => (await studio.locator('body').textContent()) ?? '',
        (text) => text.includes('fulfilled') && text.includes('processing'),
        'Admin Firestore document fields in Studio Data view',
      );
      assert.equal(await studio.locator('.fs-add').count(), 0);
      assert.equal(await studio.locator('.fs-doc-del').count(), 0);
      await studio.close();

      const rtdbStudio = await app.page(`${host.url}/__pyric/ui/rtdb/queues/q-1`);
      await rtdbStudio.locator('[data-live-observed-badge]').waitFor({ timeout: 30_000 });
      assert.equal(
        await rtdbStudio.locator('[data-live-observed-badge]').textContent(),
        'Observed · Admin · Partial · Read-only',
      );
      await eventually(
        async () => (await rtdbStudio.locator('[data-pyric-ui="rtdb-tree"]').textContent()) ?? '',
        (text) => text.includes('q-1') && text.includes('"us"') && text.includes('"ready"'),
        'Admin RTDB paths in Studio RTDB view',
      );
      assert.equal(await rtdbStudio.locator('[data-rtdb-actions]').count(), 0);
      await rtdbStudio.close();
    },
  );

  await app.step(
    'after a client SDK read joins the session, Studio updates provenance to Observed · Client + Admin while keeping .pyric/ untouched',
    async () => {
      const clientPage = await app.page(`${host.url}/?backend=${encodeURIComponent(replay.origin)}`);
      await clientPage.waitForFunction(
        () => document.querySelector('#status')?.textContent !== 'Starting',
        undefined,
        { timeout: 30_000 },
      );
      assert.equal(await clientPage.evaluate(() => document.querySelector('#status')?.textContent), 'Ready');
      assert.deepEqual(await clientPage.evaluate(() => readCatalogItem()), { label: 'Widget' });

      const combined = await eventually(
        () => hostJson<SessionSnapshot>(`${host.url}/__pyric/live/session-data`),
        (snap) => snap.sources?.client === true && snap.sources?.admin === true,
        'Combined Client + Admin session-data snapshot',
      );
      assert.deepEqual(combined.firestore['catalog/cat-1'], { label: 'Widget' });
      assert.deepEqual(combined.firestore['orders/ord-1']?.status, 'fulfilled');

      const studio = await app.page(`${host.url}/__pyric/ui/firestore/catalog/cat-1`);
      await studio.locator('[data-live-observed-badge]').waitFor({ timeout: 30_000 });
      await eventually(
        async () => (await studio.locator('[data-live-observed-badge]').textContent()) ?? '',
        (badge) => badge.includes('Observed · Client + Admin · Partial · Read-only'),
        'Observed · Client + Admin badge in Studio',
      );
      await eventually(
        async () => (await studio.locator('body').textContent()) ?? '',
        (text) => text.includes('Widget'),
        'Client-read document in Studio Data view',
      );

      assertNoObservedValuesInHostedState(app, [SECRET_VALUE, 'fulfilled', 'ord-1', 'q-1', 'Widget']);

      const exported = await app.pyric(['sandbox', 'seed-from-live', '--out', 'seed.json']);
      assert.equal(exported.code, 0, exported.output);
      const seed = JSON.parse(app.readFile('seed.json')) as {
        firestore?: Record<string, Record<string, unknown>>;
        database?: Record<string, unknown>;
      };
      assert.equal(seed.firestore?.['orders/ord-1']?.status, 'fulfilled');
      assert.equal(seed.firestore?.['catalog/cat-1']?.label, 'Widget');
      assert.deepEqual((seed.database?.queues as Record<string, unknown> | undefined)?.['q-1'], {
        region: 'us',
        state: 'ready',
        workers: 3,
      });

      const confirmed = await app.pyric(['sandbox', 'seed-from-live', '--confirm']);
      assert.equal(confirmed.code, 0, confirmed.output);
      const seededText = hostedStateText(app);
      assert.equal(seededText.includes('fulfilled'), true, 'explicit --confirm should seed Admin Firestore data');
      assert.equal(seededText.includes('q-1'), true, 'explicit --confirm should seed Admin RTDB data');

      assert.deepEqual(await replay.unmatched(), []);
      assert.deepEqual(blockedLines(app), []);

      await studio.close();
      await clientPage.close();
      await host.process.stop();
    },
  );
});
