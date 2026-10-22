/**
 * Red-at-birth replay for Functions HTTP `onRequest` (CDD, `docs/conformance/cdd.md`).
 *
 * It runs the real `pyric sandbox` command (built CLI) in a copy of the
 * capture fixture (`firebase.json`, `fixture/index.cjs`, `public/`) with no
 * source change, connects a browser-mode worker peer, and sends every probe's
 * requests with `fetch`. Each row's assertion set compares the probe
 * projection against the frozen production observation, or, for pyric-owned
 * rows, asserts the behavior the row states.
 *
 * Normal CLI test runs skip it; `compat:climb` sets PYRIC_CLIMB=1. Rows 11
 * and 12 wait on real timeouts and run last, in the slow group. There is no
 * switch to skip them: the climb lane counts a skipped assertion set as green.
 */
import 'fake-indexeddb/auto';
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  functionsHttpCaptureDir,
  functionsHttpProbes,
  functionsHttpRows,
  sendProbe,
  sendProbeRequest,
  type EchoReport,
  type ProbeResponse,
  type ProbeTargets,
} from '@pyric/conformance/functions-http-fixture';
import { doc, getDoc } from 'pyric/firestore';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from '../functions-rtdb/worker-peer.js';

const climbDescribe = process.env.PYRIC_CLIMB === '1' ? describe : describe.skip;

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');
const OBS_DIR = join(repoRoot, 'packages/conformance/observations/functions-http');
const PROJECT_ID = 'demo-functions-http';
const SERVING_TIMEOUT_MS = 30_000;
const ALLOW_ALL_FIRESTORE = "rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{document=**} { allow read, write: if true; } } }";

type Behavior = Record<string, unknown>;
type HostCtx = Awaited<ReturnType<typeof createFunctionsWorkerHostCtx>>;

const SLOW_PROBES = new Set([
  'functions-http-onrequest-no-response-timeout',
  'functions-http-onrequest-uncaught-async',
]);

interface Session {
  cwd: string;
  url: string;
  command: ChildProcess;
  ctx: HostCtx;
  output(): string;
  /** The answer a function route gave before any sandbox peer connected. */
  beforePeer: Record<string, ProbeResponse>;
  /** Whether the echo function answered 200 within SERVING_TIMEOUT_MS of the peer connecting. */
  serving: boolean;
  targets: ProbeTargets;
}

interface Replay {
  behavior: Record<string, Behavior>;
  responses: Record<string, Record<string, ProbeResponse>>;
}

let session: Promise<Session> | undefined;
let fastReplay: Promise<Replay> | undefined;
let slowReplay: Promise<Replay> | undefined;
let closePeer: (() => Promise<void>) | undefined;

function observation(name: string): Behavior {
  const path = join(OBS_DIR, `${name}.json`);
  if (!existsSync(path)) throw new Error(`observation ${name} is not captured yet`);
  return (JSON.parse(readFileSync(path, 'utf8')) as { behavior: Behavior }).behavior;
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(50);
  }
  return null;
}

function functionPath(name: string, region = 'us-central1'): string {
  return `/${PROJECT_ID}/${region}/${name}`;
}

/** A copy of the capture fixture, the files production deploys and nothing else. */
function stageFixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pyric-functions-http-'));
  cpSync(join(functionsHttpCaptureDir, 'firebase.json'), join(cwd, 'firebase.json'));
  cpSync(join(functionsHttpCaptureDir, 'public'), join(cwd, 'public'), { recursive: true });
  mkdirSync(join(cwd, 'fixture/node_modules'), { recursive: true });
  for (const file of ['index.cjs', 'package.json']) {
    cpSync(join(functionsHttpCaptureDir, 'fixture', file), join(cwd, 'fixture', file));
  }
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(cwd, 'fixture/node_modules/firebase-functions'),
  );
  writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));
  return cwd;
}

async function startSession(): Promise<Session> {
  if (!existsSync(cliEntry)) throw new Error(`build the CLI first: ${cliEntry}`);
  const cwd = stageFixture();
  let output = '';
  const command = spawn('node', [cliEntry, 'sandbox', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  command.stdout?.setEncoding('utf8');
  command.stderr?.setEncoding('utf8');
  command.stdout?.on('data', (chunk: string) => { output += chunk; });
  command.stderr?.on('data', (chunk: string) => { output += chunk; });

  const pointer = await waitFor(() => {
    const path = join(cwd, '.pyric/serve.json');
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { url: string }) : null;
  }, 15_000);
  if (!pointer) throw new Error(`pyric sandbox did not start:\n${output}`);
  const url = pointer.url.replace(/\/$/, '');

  const beforePeer = {
    emulatorPath: await sendProbeRequest(`${url}${functionPath('pyricHttpEcho')}`, { id: 'before-peer', function: 'pyricHttpEcho', via: 'cloudfunctions' }),
    rewrite: await sendProbeRequest(`${url}/api/before-peer`, { id: 'before-peer-rewrite', function: 'pyricHttpEcho', via: 'hosting' }),
  };

  const ctx = await createFunctionsWorkerHostCtx({
    persistenceKeyPrefix: 'functions-http-conformance',
    instanceId: 'functions-http-conformance',
    firestoreRules: ALLOW_ALL_FIRESTORE,
  });
  const peer = await connectFunctionsWorkerPeer({
    url: `${url.replace(/^http/, 'ws')}/__pyric/sandbox`,
    ctx,
    sandboxId: 'functions-http-conformance-peer',
  });
  closePeer = peer.close;

  const serving = (await waitFor(async () => {
    const response = await sendProbeRequest(`${url}${functionPath('pyricHttpEcho')}`, { id: 'ready', function: 'pyricHttpEcho', via: 'cloudfunctions', clientTimeoutMs: 2_000 });
    return response.status === 200 ? true : null;
  }, SERVING_TIMEOUT_MS)) === true;

  return {
    cwd,
    url,
    command,
    ctx,
    output: () => output,
    beforePeer,
    serving,
    targets: {
      functionBase: (region) => `${url}/${PROJECT_ID}/${region}`,
      runBase: (name, region) => `${url}${functionPath(name, region)}`,
      hostingBase: () => url,
    },
  };
}

function servingSession(): Promise<Session> {
  session ??= startSession();
  return session.then((started) => {
    if (!started.serving) {
      throw new Error(`pyric sandbox does not serve onRequest functions yet:\n${started.output().slice(-2_000)}`);
    }
    return started;
  });
}

async function replay(slow: boolean): Promise<Replay> {
  const started = await servingSession();
  const result: Replay = { behavior: {}, responses: {} };
  for (const probe of functionsHttpProbes) {
    if (SLOW_PROBES.has(probe.name) !== slow) continue;
    const responses = await sendProbe(probe.requests, started.targets);
    result.responses[probe.name] = responses;
    result.behavior[probe.name] = probe.behavior(responses);
  }
  return result;
}

function fast(): Promise<Replay> {
  fastReplay ??= replay(false);
  return fastReplay;
}

function slow(): Promise<Replay> {
  slowReplay ??= fast().then(() => replay(true));
  return slowReplay;
}

function pick(behavior: Behavior, keys?: readonly string[]): Behavior {
  if (!keys) return behavior;
  return Object.fromEntries(keys.map((key) => [key, behavior[key]]));
}

/** The probe's local projection equals the production observation, on `keys` when given. */
async function replayed(name: string, keys?: readonly string[], run: () => Promise<Replay> = fast): Promise<void> {
  const production = observation(name);
  const local = (await run()).behavior[name];
  expect(pick(local, keys)).toEqual(pick(production, keys));
}

function echoOf(response: ProbeResponse): EchoReport {
  return response.json as EchoReport;
}

interface RowAssertion {
  /** The observation this row replays, if it replays one. */
  observation?: string;
  slow?: boolean;
  run(): Promise<void>;
}

const BODY_JSON_KEYS = ['json', 'json-charset', 'cloudevents-json', 'empty-json'];
const BODY_OTHER_KEYS = ['text', 'urlencoded', 'octet-stream', 'unknown-type', 'no-content-type', 'empty', 'vendor-json'];

const ROWS: Record<string, RowAssertion> = {
  'functions-http#1': {
    async run() {
      const { url } = await servingSession();
      const at = (path: string) => sendProbeRequest(`${url}${path}`, { id: 'row-1', function: 'pyricHttpEcho', via: 'cloudfunctions' });
      const echo = await at(functionPath('pyricHttpEcho'));
      expect(echo.status).toBe(200);
      expect(echoOf(echo).method).toBe('GET');
      expect((await at(functionPath('pyricHttpRegional', 'us-east1'))).status).toBe(200);
      expect((await at(functionPath('pyricHttpRegional', 'us-central1'))).status).toBe(404);
      expect((await at(functionPath('pyricHttpEcho', 'us-east1'))).status).toBe(404);
    },
  },
  'functions-http#2': { observation: 'functions-http-onrequest-v1', run: () => replayed('functions-http-onrequest-v1') },
  'functions-http#3': { observation: 'functions-http-onrequest-basic-get', run: () => replayed('functions-http-onrequest-basic-get') },
  'functions-http#4': { observation: 'functions-http-onrequest-subpath', run: () => replayed('functions-http-onrequest-subpath') },
  'functions-http#5': {
    observation: 'functions-http-onrequest-body-parsing',
    run: () => replayed('functions-http-onrequest-body-parsing', BODY_JSON_KEYS),
  },
  'functions-http#6': {
    observation: 'functions-http-onrequest-body-parsing',
    run: () => replayed('functions-http-onrequest-body-parsing', BODY_OTHER_KEYS),
  },
  'functions-http#7': { observation: 'functions-http-onrequest-malformed-json', run: () => replayed('functions-http-onrequest-malformed-json') },
  'functions-http#8': { observation: 'functions-http-onrequest-response-shapes', run: () => replayed('functions-http-onrequest-response-shapes') },
  'functions-http#9': { observation: 'functions-http-onrequest-handler-failure', run: () => replayed('functions-http-onrequest-handler-failure') },
  'functions-http#10': { observation: 'functions-http-onrequest-headers-sent-failure', run: () => replayed('functions-http-onrequest-headers-sent-failure') },
  'functions-http#11': {
    observation: 'functions-http-onrequest-no-response-timeout',
    slow: true,
    run: () => replayed('functions-http-onrequest-no-response-timeout', undefined, slow),
  },
  'functions-http#12': {
    observation: 'functions-http-onrequest-uncaught-async',
    slow: true,
    async run() {
      // Pyric's side first, so it is checked whether or not the observation is captured.
      const { url, output } = await servingSession();
      const whoami = async (mode?: string) => sendProbeRequest(
        `${url}${functionPath('pyricHttpUncaught')}${mode ? `?mode=${mode}` : ''}`,
        { id: 'row-12', function: 'pyricHttpUncaught', via: 'cloudfunctions' },
      );
      const before = await whoami();
      expect((await whoami('after-response')).status).toBe(200);
      await Bun.sleep(300);
      const after = await whoami();
      expect(after.status).toBe(200);
      expect(echoOf(after).instanceId).toBe(echoOf(before).instanceId);
      expect(output()).not.toMatch(/functions child exited|unexpected-exit/i);
      await replayed('functions-http-onrequest-uncaught-async', undefined, slow);
    },
  },
  'functions-http#13': { observation: 'functions-http-onrequest-cors-unset', run: () => replayed('functions-http-onrequest-cors-unset') },
  'functions-http#14': { observation: 'functions-http-onrequest-cors-configured', run: () => replayed('functions-http-onrequest-cors-configured') },
  'functions-http#15': {
    observation: 'functions-http-onrequest-invoker-private',
    async run() {
      // By-design divergence (owner decision): production refuses, pyric serves and warns once.
      const production = observation('functions-http-onrequest-invoker-private') as Record<string, Record<string, unknown>>;
      expect(production.cloudfunctions.status).toBe(403);
      expect(production.cloudfunctions.reachedHandler).toBe(false);
      const local = (await fast()).behavior['functions-http-onrequest-invoker-private'] as Record<string, Record<string, unknown>>;
      expect(local.cloudfunctions.status).toBe(200);
      expect(local.cloudfunctions.reachedHandler).toBe(true);
      const { output } = await servingSession();
      const warnings = output().split('\n').filter((line) => /pyricHttpPrivate/.test(line) && /invoker/i.test(line));
      expect(warnings).toHaveLength(1);
    },
  },
  'functions-http#16': { observation: 'functions-http-onrequest-not-found', run: () => replayed('functions-http-onrequest-not-found') },
  'functions-http#17': { observation: 'functions-http-hosting-rewrite', run: () => replayed('functions-http-hosting-rewrite') },
  'functions-http#18': {
    async run() {
      const { url, ctx } = await servingSession();
      const id = `row-18-${randomUUID()}`;
      const response = await sendProbeRequest(`${url}${functionPath('pyricHttpEcho')}?adminWrite=${id}`, { id: 'row-18', function: 'pyricHttpEcho', via: 'cloudfunctions' });
      expect(response.status).toBe(200);
      const written = await getDoc(doc(ctx.db, `pyric_oracle_http/${id}`));
      expect(written.exists()).toBe(true);
      expect(written.data()).toEqual({ writtenBy: 'pyricHttpEcho', id });
    },
  },
  'functions-http#19': {
    async run() {
      const { url } = await servingSession();
      const stream = () => sendProbeRequest(`${url}${functionPath('pyricHttpResponses')}?shape=stream`, { id: 'row-19', function: 'pyricHttpResponses', via: 'cloudfunctions' });
      const startedAt = Date.now();
      const [first, second] = await Promise.all([stream(), stream()]);
      // Each stream holds its response open for 250 ms; served one at a time they would take 500 ms.
      expect(Date.now() - startedAt).toBeLessThan(450);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect([first.body, second.body]).toEqual(['chunk-1\nchunk-2\nchunk-3\n', 'chunk-1\nchunk-2\nchunk-3\n']);
      // maxInstances: 1 is read and not applied: two overlapping requests are both served.
      const whoami = () => sendProbeRequest(`${url}${functionPath('pyricHttpUncaught')}`, { id: 'row-19-max', function: 'pyricHttpUncaught', via: 'cloudfunctions' });
      const capped = await Promise.all([whoami(), whoami()]);
      expect(capped.map((response) => response.status)).toEqual([200, 200]);
    },
  },
  'functions-http#20': {
    async run() {
      session ??= startSession();
      const { beforePeer } = await session;
      for (const response of Object.values(beforePeer)) {
        expect(response.status).toBe(503);
        expect(response.body).toMatch(/browser tab/i);
      }
    },
  },
  'functions-http#21': {
    async run() {
      const { url, output } = await servingSession();
      const marker = `exec-${randomUUID()}`;
      const response = await sendProbeRequest(`${url}${functionPath('pyricHttpEcho')}/${marker}`, { id: 'row-21', function: 'pyricHttpEcho', via: 'cloudfunctions' });
      expect(response.status).toBe(200);
      const records = await waitFor(() => {
        const lines = output().split('\n').filter((line) => line.includes(marker));
        return lines.length > 0 ? lines : null;
      }, 2_000);
      expect(records).not.toBeNull();
      expect(records).toHaveLength(1);
      expect(records![0]).toContain('pyricHttpEcho');
      expect(records![0]).toContain(`GET /${marker}`);
      expect(records![0]).toContain('200');
    },
  },
};

/** Observations no row replays, each with the reason. */
const NOT_APPLICABLE: Record<string, string> = {};

afterAll(async () => {
  if (closePeer) await closePeer().catch(() => undefined);
  const started = await session?.catch(() => undefined);
  if (started?.command.exitCode === null) started.command.kill('SIGKILL');
});

for (const row of functionsHttpRows) {
  const assertion = ROWS[row.id];
  if (!assertion) continue;
  const label = assertion.slow ? `slow ${row.id}` : row.id;
  climbDescribe(`${label} ${row.api}`, () => {
    test(row.behavior, () => assertion.run(), assertion.slow ? 240_000 : 120_000);
  });
}

climbDescribe('functions-http climb completeness', () => {
  test('every registry row has exactly one assertion set', () => {
    expect(Object.keys(ROWS).sort()).toEqual(functionsHttpRows.map((row) => row.id).sort());
  });

  test('every probe is replayed by a row or excused', () => {
    const replayedNames = new Set(Object.values(ROWS).flatMap((row) => (row.observation ? [row.observation] : [])));
    const unreplayed = functionsHttpProbes
      .map((probe) => probe.name)
      .filter((name) => !replayedNames.has(name) && !(name in NOT_APPLICABLE));
    expect(unreplayed).toEqual([]);
  });

  test('every committed functions-http- observation is a probe this suite replays', () => {
    const probeNames = new Set(functionsHttpProbes.map((probe) => probe.name));
    const committed = existsSync(OBS_DIR)
      ? readdirSync(OBS_DIR).filter((file) => file.startsWith('functions-http-') && file.endsWith('.json'))
      : [];
    const orphans = committed
      .map((file) => file.slice(0, -'.json'.length))
      .filter((name) => !probeNames.has(name) && !(name in NOT_APPLICABLE));
    expect(orphans).toEqual([]);
  });
});
