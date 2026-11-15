/**
 * Live mode Admin project gates driven through the packed `@pyric/live/register`
 * and `firebase-admin` entrypoints:
 *
 * - Firestore GAPIC `v1.FirestoreClient` refuses non-plain and protobufjs message
 *   instances targeting another project or a non-default database before any HTTP
 *   request reaches the wire.
 * - Cloud Storage refuses cross-project `requestStream` calls, `/projects/<other>`
 *   path URIs, `?project=<other>` query URIs, non-plain option instances, and
 *   request interceptor URI rewrites before any HTTP request reaches the wire.
 * - File-path `FIREBASE_CONFIG` naming another project or pointing to an unreadable
 *   file is refused at startup across root processes, child processes, and Workers,
 *   while a host-project config file starts cleanly.
 *
 * On Node 22, where CommonJS `require()` skips `module.registerHooks`, the Admin
 * rows stay shut and `firebase-admin/app` is refused at import time, naming Node 23.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { scenario, type ExpectedCrash } from '../driver.ts';

const HOST_PROJECT = 'demo-live-admin-gates';
const OTHER_PROJECT = 'demo-live-other';
const LIVE_REFUSED = 'PYRIC_LIVE_REFUSED';

const NODE_VERSION = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim();
const ADMIN_ROWS_ON = Number(NODE_VERSION.split('.')[0]) >= 23;

function buildExpectedCrashes(): ExpectedCrash[] {
  if (ADMIN_ROWS_ON) {
    return [
      {
        message: /^Error: @pyric\/live: firebase-admin is refused in live mode, from a Node process: the projectId in the environment variable FIREBASE_CONFIG names the project 'demo-live-other'/,
        source: /^command \d+ \(node --import @pyric\/live\/register config-probe\.mjs\)$/,
        reason: 'the step that starts a process with a cross-project file-path FIREBASE_CONFIG is refused at register start',
      },
      {
        message: /^Error: @pyric\/live: firebase-admin is refused in live mode, from a Node process: the environment variable FIREBASE_CONFIG could not be read/,
        source: /^command \d+ \(node --import @pyric\/live\/register config-probe\.mjs\)$/,
        reason: 'the step that starts a process with an unreadable file-path FIREBASE_CONFIG fails closed at register start',
      },
    ];
  }
  return [
    {
      message: /^Error: @pyric\/live: firebase-admin\/app \(the Admin SDK\) is refused in live mode\. @pyric\/live observes firebase-admin on Node 23 or later/,
      source: /^command \d+ \(node --import @pyric\/live\/register config-probe\.mjs\)$/,
      reason: 'on Node 22, whose require() skips the hooks, the Admin rows stay shut and the process is refused its import',
    },
  ];
}

export const expectedCrashes: ExpectedCrash[] = buildExpectedCrashes();

function resultOf<T>(output: string): T {
  const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `no RESULT line:\n${output}`);
  return JSON.parse(line.slice('RESULT '.length)) as T;
}

export default scenario(async (app) => {
  if (!ADMIN_ROWS_ON) {
    await app.step(`on Node ${NODE_VERSION}, firebase-admin is refused, naming Node 23`, async () => {
      const run = await app.command('node', ['--import', '@pyric/live/register', 'config-probe.mjs'], {
        timeoutMs: 60_000,
      });
      assert.notEqual(run.code, 0, run.output);
      assert.match(run.output, /@pyric\/live observes firebase-admin on Node 23 or later/);
    });
    return;
  }

  const hits: Array<{ method: string; url: string }> = [];
  const server = createServer((req, res) => {
    hits.push({ method: req.method ?? 'GET', url: req.url ?? '/' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        name: `projects/${HOST_PROJECT}/databases/(default)/documents/items/1`,
        fields: {},
        items: [],
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string', 'loopback server address');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    app.writeFile('host-config.json', `${JSON.stringify({ projectId: HOST_PROJECT })}\n`);
    app.writeFile('other-config.json', `${JSON.stringify({ projectId: OTHER_PROJECT })}\n`);
    const hostConfigPath = join(app.dir, 'host-config.json');
    const otherConfigPath = join(app.dir, 'other-config.json');
    const missingConfigPath = join(app.dir, 'missing-config.json');

    await app.step('a host-project file-path FIREBASE_CONFIG starts cleanly', async () => {
      const run = await app.command('node', ['--import', '@pyric/live/register', 'config-probe.mjs'], {
        env: { FIREBASE_CONFIG: hostConfigPath },
        timeoutMs: 60_000,
      });
      assert.equal(run.code, 0, run.output);
      assert.deepEqual(resultOf(run.output), { projectId: HOST_PROJECT });
    });

    await app.step('a cross-project file-path FIREBASE_CONFIG is refused at register start', async () => {
      const run = await app.command('node', ['--import', '@pyric/live/register', 'config-probe.mjs'], {
        env: { FIREBASE_CONFIG: otherConfigPath },
        timeoutMs: 60_000,
      });
      assert.notEqual(run.code, 0, run.output);
      assert.match(run.output, /PYRIC_LIVE_REFUSED/);
      assert.match(run.output, new RegExp(OTHER_PROJECT));
    });

    await app.step('an unreadable file-path FIREBASE_CONFIG fails closed at register start', async () => {
      const run = await app.command('node', ['--import', '@pyric/live/register', 'config-probe.mjs'], {
        env: { FIREBASE_CONFIG: missingConfigPath },
        timeoutMs: 60_000,
      });
      assert.notEqual(run.code, 0, run.output);
      assert.match(run.output, /PYRIC_LIVE_REFUSED/);
    });

    await app.step('GAPIC non-plain/protobufjs, Storage URI/stream/option vectors, and nested file-path FIREBASE_CONFIG are all refused with zero wire hits', async () => {
      hits.length = 0;
      const run = await app.command('node', ['--import', '@pyric/live/register', 'probe.mjs'], {
        env: {
          PROBE_HOST_PROJECT: HOST_PROJECT,
          PROBE_OTHER_PROJECT: OTHER_PROJECT,
          PROBE_ORIGIN: origin,
          PROBE_PORT: String(address.port),
          PROBE_OTHER_CONFIG_FILE: otherConfigPath,
          STORAGE_EMULATOR_HOST: origin,
        },
        timeoutMs: 60_000,
      });
      assert.equal(run.code, 0, run.output);
      const outcome = resultOf<{
        gapic: Record<string, string>;
        storage: Record<string, string>;
        nestedConfig: { childExitedNonZero: boolean; childRefused: boolean; workerRefused: boolean };
      }>(run.output);

      assert.deepEqual(outcome.gapic, {
        hostProto: 'OK',
        classOther: LIVE_REFUSED,
        nonEnumProtoOther: LIVE_REFUSED,
        protoOther: LIVE_REFUSED,
        protoNamedDb: LIVE_REFUSED,
      });
      assert.deepEqual(outcome.storage, {
        hostFiles: 'OK',
        requestStreamOtherBucket: LIVE_REFUSED,
        projectsPathAuthReq: LIVE_REFUSED,
        queryProjectAuthReq: LIVE_REFUSED,
        qsBucketAuthReq: LIVE_REFUSED,
        nonPlainGetBuckets: LIVE_REFUSED,
        interceptorRewrite: LIVE_REFUSED,
      });
      assert.deepEqual(outcome.nestedConfig, {
        childExitedNonZero: true,
        childRefused: true,
        workerRefused: true,
      });

      const forbiddenHits = hits.filter(
        (hit) => hit.url.includes(OTHER_PROJECT) || hit.url.includes('/databases/other-db/'),
      );
      assert.deepEqual(forbiddenHits, []);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
