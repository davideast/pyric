/**
 * Red-at-birth replay for Functions callable `onCall` and the
 * `firebase/functions` client (CDD, `docs/conformance/cdd.md`).
 *
 * It runs the real `pyric sandbox` command (built CLI) in a copy of the
 * capture fixture (`firebase.json`, `fixture/index.cjs`, `public/`) with no
 * source change, and opens the fixture's page in headless Chromium, which is
 * the sandbox peer. Wire probes send their requests with the sender the
 * capture harness uses; the page mints the ID and App Check tokens a probe
 * names, as the run's test user does in production. Client probes run the
 * capture's page program against the served `firebase/functions`. The Node
 * host rows run `pyric sandbox --hosted` on a second copy and call the same
 * program from a `node --import @pyric/cli/register` process.
 *
 * Each row's assertion set compares the probe projections against the frozen
 * production observations, or, for upstream and pyric-owned rows, asserts the
 * behavior the row states.
 *
 * Normal CLI test runs skip it; `compat:climb` sets PYRIC_CLIMB=1.
 */
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
import { chromium, type Browser, type Page } from '@playwright/test';
import {
  CALLABLE_BROWSER_SOURCE,
  functionsCallableCaptureDir,
  functionsCallableProbes,
  functionsCallableRows,
  sendProbe,
  sendProbeRequest,
  callableBody,
  type AppCheckTokenKind,
  type AuthTokenKind,
  type CallableProbeRequest,
  type ClientScenarioInput,
  type FunctionsCallableClientProbe,
  type FunctionsCallableProbe,
  type FunctionsCallableWireProbe,
  type ProbeResponse,
  type ProbeTargets,
} from '@pyric/conformance/functions-callable-fixture';
import { SANDBOX_TOKEN_PREFIX } from 'pyric-admin/auth';
import { mintIdToken } from 'pyric/sandbox/internal';
import { sdkImportMap } from '../../src/serve/html-injection.js';
import { functionsChildrenOf, isAlive } from '../functions-http/children.js';

const climbDescribe = process.env.PYRIC_CLIMB === '1' ? describe : describe.skip;

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');
const OBS_DIR = join(repoRoot, 'packages/conformance/observations/functions-callable');
const PROJECT_ID = 'demo-functions-callable';
const REGION = 'us-central1';
const SERVING_TIMEOUT_MS = 30_000;
const TEST_USER = 'callable-conformance-user';
const CUSTOM_TOKEN = `${SANDBOX_TOKEN_PREFIX}:${TEST_USER}:{}`;
const WEB_CONFIG = {
  apiKey: 'pyric-callable-conformance',
  projectId: PROJECT_ID,
  appId: '1:000000000000:web:0000000000000000',
};
/** The warning the CLI prints for an export no trigger family serves. */
const UNSUPPORTED_CALLABLE = /functions export \S+ uses unsupported trigger callable[^\n]*/g;

type Behavior = Record<string, unknown>;
type Facts = Record<string, unknown>;

/** One settled call, as the page programs report it. */
interface CallFacts {
  threw: boolean;
  name?: string | null;
  code?: string | null;
  message?: string;
  value?: { resultKeys: string[]; dataType: string; data: unknown };
}

/** Page scenarios beyond the capture's: the upstream and pyric-owned rows, and the tokens a wire probe names. */
const LOCAL_SOURCE = String.raw`
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import { CustomProvider, getLimitedUseToken, getToken, initializeAppCheck } from 'firebase/app-check';
import { doc, getDoc, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

let appCount = 0;
const newApp = (config) => initializeApp(config, 'callable-local-' + appCount++);
const settle = async (operation) => {
  try {
    return { threw: false, value: await operation() };
  } catch (error) {
    return { threw: true, name: error?.name ?? null, code: error?.code ?? null, message: String(error?.message ?? error) };
  }
};
// Builds the callable inside the settled operation, so a client that throws on getFunctions reports it as the call's outcome.
const callFacts = (makeCallable, data) => settle(async () => {
  const result = await makeCallable()(data);
  return { resultKeys: Object.keys(result).sort(), dataType: typeof result.data, data: result.data };
});
const echoOf = (app, region, options) => () => httpsCallable(getFunctions(app, region), 'pyricCallableEcho', options);

let appCheckApp;
const appCheckOf = (config) => {
  appCheckApp ??= initializeAppCheck(newApp(config), {
    provider: new CustomProvider({ getToken: async () => { throw new Error('debug mode must not call the provider'); } }),
    isTokenAutoRefreshEnabled: false,
  });
  return appCheckApp;
};

globalThis.functionsCallableLocal = {
  async idToken(config, input) {
    const auth = getAuth(newApp(config));
    await signInWithCustomToken(auth, input.customToken);
    return auth.currentUser.getIdToken();
  },
  async appCheckToken(config) {
    return (await getToken(appCheckOf(config))).token;
  },
  async limitedUseToken(config) {
    return (await getLimitedUseToken(appCheckOf(config))).token;
  },
  async timeout(config, input) {
    return { call: await callFacts(echoOf(newApp(config), input.region, { timeout: 200 }), { mode: 'delay', ms: 3000 }) };
  },
  async adminWrite(config, input) {
    const app = newApp(config);
    const call = await callFacts(echoOf(app, input.region), { mode: 'admin-write', id: input.id });
    const read = await settle(async () => {
      const snapshot = await getDoc(doc(getFirestore(app), 'pyric_oracle_callable/' + input.id));
      return { exists: snapshot.exists(), data: snapshot.data() ?? null };
    });
    return { call, read };
  },
  async emulator(config, input) {
    const app = newApp(config);
    const accepted = await settle(async () => {
      const functions = getFunctions(app, input.region);
      connectFunctionsEmulator(functions, '127.0.0.1', 5001);
      connectFunctionsEmulator(functions, '127.0.0.1', 5001);
      return true;
    });
    const call = await callFacts(echoOf(app, input.region), { via: 'emulator' });
    return { accepted, call };
  },
  async echo(config, input) {
    return { call: await callFacts(echoOf(newApp(config), input.region), { via: input.via }) };
  },
};

// The first call a page makes, issued as the page loads, while the Functions child may still be starting.
if (globalThis.PYRIC_CALLABLE_CONFIG) {
  globalThis.functionsCallableFirstCall = callFacts(echoOf(newApp(globalThis.PYRIC_CALLABLE_CONFIG), 'us-central1'), { via: 'first-call' });
}
`;

/** Runs one page scenario in a registered Node process and prints its facts as one line. */
const REGISTERED_RUNNER = String.raw`
await import('./callable-browser-source.mjs');
await import('./callable-local-source.mjs');
const [namespace, scenario, configJson, inputJson] = process.argv.slice(2);
try {
  const facts = await globalThis[namespace][scenario](JSON.parse(configJson), JSON.parse(inputJson));
  process.stdout.write('PYRIC_FACTS ' + JSON.stringify(facts) + '\n');
} catch (error) {
  process.stdout.write('PYRIC_THREW ' + JSON.stringify({ name: error?.name ?? null, message: String(error?.message ?? error) }) + '\n');
}
process.exit(0);
`;

type Namespace = 'functionsCallableProbes' | 'functionsCallableLocal';

interface Plane {
  cwd: string;
  url: string;
  command: ChildProcess;
  output(): string;
}

interface BrowserPlane extends Plane {
  browser: Browser;
  page: Page;
  consoleLines: string[];
  /** The answer a callable route gave before any sandbox peer connected. */
  beforePeer: Record<string, ProbeResponse>;
  /** Whether the echo callable answered 200 within SERVING_TIMEOUT_MS of the page connecting. */
  serving: boolean;
  targets: ProbeTargets;
}

let browserPlane: Promise<BrowserPlane> | undefined;
let hostedPlane: Promise<Plane> | undefined;
let wireTokens: Promise<{ idToken: string; appCheck: string }> | undefined;

function observation(name: string): Behavior {
  const path = join(OBS_DIR, `${name}.json`);
  if (!existsSync(path)) throw new Error(`observation not captured: ${name}`);
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

function functionPath(name: string, region = REGION): string {
  return `/${PROJECT_ID}/${region}/${name}`;
}

function linkPackage(cwd: string, name: string, target: string): void {
  const link = join(cwd, 'node_modules', name);
  mkdirSync(resolve(link, '..'), { recursive: true });
  symlinkSync(target, link);
}

/** A copy of the capture fixture, the files production deploys, plus what a registered process resolves. */
function stageFixture(label: string): string {
  const cwd = mkdtempSync(join(tmpdir(), `pyric-functions-callable-${label}-`));
  cpSync(join(functionsCallableCaptureDir, 'firebase.json'), join(cwd, 'firebase.json'));
  cpSync(join(functionsCallableCaptureDir, 'public'), join(cwd, 'public'), { recursive: true });
  mkdirSync(join(cwd, 'fixture/node_modules'), { recursive: true });
  for (const file of ['index.cjs', 'package.json']) {
    cpSync(join(functionsCallableCaptureDir, 'fixture', file), join(cwd, 'fixture', file));
  }
  symlinkSync(
    join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
    join(cwd, 'fixture/node_modules/firebase-functions'),
  );
  writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: PROJECT_ID } }));
  linkPackage(cwd, '@pyric/cli', cliRoot);
  linkPackage(cwd, 'pyric', join(repoRoot, 'packages/pyric'));
  linkPackage(cwd, 'pyric-admin', join(repoRoot, 'packages/pyric-admin'));
  linkPackage(cwd, 'firebase', join(repoRoot, 'node_modules/firebase'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'functions-callable-conformance', private: true, type: 'module' }));
  writeFileSync(join(cwd, 'callable-browser-source.mjs'), CALLABLE_BROWSER_SOURCE);
  writeFileSync(join(cwd, 'callable-local-source.mjs'), LOCAL_SOURCE);
  writeFileSync(join(cwd, 'callable-runner.mjs'), REGISTERED_RUNNER);
  return cwd;
}

async function startCommand(label: string, flags: readonly string[]): Promise<Plane> {
  if (!existsSync(cliEntry)) throw new Error(`build the CLI first: ${cliEntry}`);
  const cwd = stageFixture(label);
  let output = '';
  const command = spawn('node', [cliEntry, 'sandbox', ...flags, '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'], {
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
  if (!pointer) throw new Error(`pyric sandbox ${flags.join(' ')} did not start:\n${output}`);
  return { cwd, url: pointer.url.replace(/\/$/, ''), command, output: () => output };
}

/** Whether the echo callable answers a callable POST; false as soon as the CLI says it will not serve callables. */
async function waitForServing(plane: Plane): Promise<boolean> {
  const answered = await waitFor(async () => {
    if (plane.output().match(UNSUPPORTED_CALLABLE)) return false;
    const response = await sendProbeRequest(`${plane.url}${functionPath('pyricCallableEcho')}`, {
      id: 'ready',
      function: 'pyricCallableEcho',
      via: 'cloudfunctions',
      clientTimeoutMs: 2_000,
      ...callableBody({}),
    });
    return response.status === 200 ? true : null;
  }, SERVING_TIMEOUT_MS);
  return answered === true;
}

function notServing(plane: Plane): Error {
  const refusals = plane.output().match(UNSUPPORTED_CALLABLE);
  const detail = refusals ? refusals.join('\n') : plane.output().slice(-2_000);
  return new Error(`pyric sandbox does not serve callable functions yet:\n${detail}`);
}

async function startBrowserPlane(): Promise<BrowserPlane> {
  const plane = await startCommand('browser', []);
  const echoBeforePeer = (via: 'cloudfunctions' | 'hosting', path: string) =>
    sendProbeRequest(`${plane.url}${path}`, { id: 'before-peer', function: 'pyricCallableEcho', via, ...callableBody({}) });
  const beforePeer = {
    emulatorPath: await echoBeforePeer('cloudfunctions', functionPath('pyricCallableEcho')),
    rewrite: await echoBeforePeer('hosting', '/pyricCallableEcho'),
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript(([debugToken, config]) => {
    const scope = self as unknown as Record<string, unknown>;
    scope.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;
    scope.PYRIC_CALLABLE_CONFIG = config;
  }, [randomUUID(), WEB_CONFIG] as const);
  const page = await context.newPage();
  const consoleLines: string[] = [];
  page.on('console', (message) => consoleLines.push(message.text()));
  await page.goto(`${plane.url}/`, { waitUntil: 'load' });
  await page.addScriptTag({ type: 'module', content: CALLABLE_BROWSER_SOURCE });
  await page.addScriptTag({ type: 'module', content: LOCAL_SOURCE });
  await page.waitForFunction(() => {
    const scope = globalThis as unknown as Record<string, unknown>;
    return typeof scope.functionsCallableProbes === 'object' && typeof scope.functionsCallableLocal === 'object';
  });

  const started: BrowserPlane = {
    ...plane,
    browser,
    page,
    consoleLines,
    beforePeer,
    serving: false,
    targets: {
      functionBase: (region) => `${plane.url}/${PROJECT_ID}/${region}`,
      runBase: (name, region) => `${plane.url}${functionPath(name, region)}`,
      hostingBase: () => plane.url,
    },
  };
  started.serving = await waitForServing(started);
  return started;
}

function browserSession(): Promise<BrowserPlane> {
  browserPlane ??= startBrowserPlane();
  return browserPlane;
}

async function servingSession(): Promise<BrowserPlane> {
  const started = await browserSession();
  if (!started.serving) throw notServing(started);
  return started;
}

function hostedSession(): Promise<Plane> {
  hostedPlane ??= startCommand('hosted', ['--hosted', '--no-run']);
  return hostedPlane;
}

/** A page scenario's facts, through JSON as an observation stores them. */
async function onPage(namespace: Namespace, scenario: string, input: Facts): Promise<Facts> {
  const { page } = await browserSession();
  const json = await page.evaluate(
    async ([ns, name, config, scenarioInput]) => {
      const scope = globalThis as unknown as Record<string, Record<string, (c: unknown, i: unknown) => Promise<unknown>>>;
      return JSON.stringify(await scope[ns]![name]!(config, scenarioInput));
    },
    [namespace, scenario, WEB_CONFIG, input] as const,
  );
  return JSON.parse(json) as Facts;
}

/** The same scenario from a `node --import @pyric/cli/register` process against the Node host. */
async function inRegisteredProcess(namespace: Namespace, scenario: string, input: Facts): Promise<Facts> {
  const host = await hostedSession();
  const child = spawn(
    'node',
    ['--import', '@pyric/cli/register', 'callable-runner.mjs', namespace, scenario, JSON.stringify(WEB_CONFIG), JSON.stringify(input)],
    { cwd: host.cwd, env: { ...process.env, PYRIC_SANDBOX: `remote:${host.url}` }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  const exited = await waitFor(() => (child.exitCode !== null || child.signalCode !== null ? true : null), 60_000);
  if (!exited) child.kill('SIGKILL');
  const facts = output.match(/^PYRIC_FACTS (.*)$/m);
  if (facts) return JSON.parse(facts[1]!) as Facts;
  const threw = output.match(/^PYRIC_THREW (.*)$/m);
  if (threw) {
    const error = JSON.parse(threw[1]!) as { name: string | null; message: string };
    throw new Error(`registered process: ${error.name ?? 'Error'}: ${error.message}`);
  }
  throw new Error(`registered process printed no facts:\n${output}`);
}

/** Fails with the error a call rejected with, so a red row names what the client threw. */
function expectResolved(call: CallFacts): NonNullable<CallFacts['value']> {
  if (call.threw) throw new Error(`call rejected: ${call.name ?? 'Error'}: ${call.message}`);
  return call.value!;
}

function expectRejectedWith(call: CallFacts, code: string): void {
  if (call.threw && call.code === code) return;
  const outcome = call.threw ? `${call.name ?? 'Error'} (${call.code ?? 'no code'}): ${call.message}` : 'it resolved';
  throw new Error(`expected a call rejected with ${code}, but ${outcome}`);
}

function base64url(json: unknown): string {
  return Buffer.from(JSON.stringify(json)).toString('base64url');
}

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function pageTokens(): Promise<{ idToken: string; appCheck: string }> {
  wireTokens ??= (async () => ({
    idToken: (await onPage('functionsCallableLocal', 'idToken', { customToken: CUSTOM_TOKEN })) as unknown as string,
    appCheck: (await onPage('functionsCallableLocal', 'appCheckToken', {})) as unknown as string,
  }))();
  return wireTokens;
}

/** The sandbox ID token past its `exp`: the page's token with its times moved an hour back. */
function expiredIdToken(idToken: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = { ...decodeClaims(idToken), iat: nowSec - 7_200, auth_time: nowSec - 7_200, exp: nowSec - 3_600 };
  return mintIdToken(claims);
}

/** The token with its signature segment altered, as production's forged case alters a real token. */
function forged(token: string): string {
  const [header, payload, signature = ''] = token.split('.');
  const last = signature.at(-1) === 'A' ? 'B' : 'A';
  return `${header}.${payload}.${signature.slice(0, -1)}${last}`;
}

async function authHeader(kind: AuthTokenKind): Promise<string> {
  if (kind === 'garbage') return 'Bearer not-a-jwt';
  if (kind === 'basic') return `Basic ${Buffer.from('pyric:callable').toString('base64')}`;
  const { idToken } = await pageTokens();
  if (kind === 'forged') return `Bearer ${forged(idToken)}`;
  if (kind === 'expired') return `Bearer ${expiredIdToken(idToken)}`;
  return `Bearer ${idToken}`;
}

async function appCheckHeader(kind: AppCheckTokenKind, shared: () => Promise<string>): Promise<string> {
  if (kind === 'invalid') return `${base64url({ alg: 'none' })}.${base64url({ sub: 'not-an-app' })}.`;
  if (kind === 'limited-use-shared') return shared();
  if (kind === 'limited-use') return (await onPage('functionsCallableLocal', 'limitedUseToken', {})) as unknown as string;
  return (await pageTokens()).appCheck;
}

/** Each request with the headers its named tokens become; one limited-use token per probe for `limited-use-shared`. */
async function withTokens(requests: readonly CallableProbeRequest[]): Promise<CallableProbeRequest[]> {
  let sharedLimitedUse: Promise<string> | undefined;
  const shared = () => {
    sharedLimitedUse ??= onPage('functionsCallableLocal', 'limitedUseToken', {}) as unknown as Promise<string>;
    return sharedLimitedUse;
  };
  const sent: CallableProbeRequest[] = [];
  for (const request of requests) {
    const headers = { ...request.headers };
    if (request.tokens?.auth) headers.authorization = await authHeader(request.tokens.auth);
    if (request.tokens?.appCheck) headers['x-firebase-appcheck'] = await appCheckHeader(request.tokens.appCheck, shared);
    sent.push({ ...request, headers });
  }
  return sent;
}

function clientInput(probe: FunctionsCallableClientProbe, origin: string): ClientScenarioInput {
  return {
    region: REGION,
    urls: {
      cloudfunctions: `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/pyricCallableEcho`,
      run: 'https://pyriccallableecho-pyric-uc.a.run.app',
    },
    customDomain: origin,
    customToken: probe.scenario === 'signedIn' ? CUSTOM_TOKEN : undefined,
  };
}

async function replayWire(probe: FunctionsCallableWireProbe): Promise<void> {
  const production = observation(probe.name);
  const { targets } = await servingSession();
  const responses = await sendProbe(await withTokens(probe.requests), targets);
  expect(probe.behavior(responses)).toEqual(production);
}

/** A client probe on the page, then from a registered process against the Node host; both equal production. */
async function replayClient(probe: FunctionsCallableClientProbe): Promise<void> {
  const production = observation(probe.name);
  const { url } = await browserSession();
  const page = await onPage('functionsCallableProbes', probe.scenario, { ...clientInput(probe, url) });
  expect(probe.behavior(page)).toEqual(production);
  const host = await hostedSession();
  const hosted = await inRegisteredProcess('functionsCallableProbes', probe.scenario, { ...clientInput(probe, host.url) });
  expect(probe.behavior(hosted)).toEqual(production);
}

function replay(probe: FunctionsCallableProbe): Promise<void> {
  return probe.kind === 'wire' ? replayWire(probe) : replayClient(probe);
}

interface RowAssertion {
  /** The observations this row replays. */
  observations: string[];
  run(): Promise<void>;
}

/** Every observed row replays each probe that names it, in capture order. */
function observedRows(): Record<string, RowAssertion> {
  const rows: Record<string, RowAssertion> = {};
  for (const row of functionsCallableRows) {
    const probes = functionsCallableProbes.filter((probe) => probe.rowIds.includes(row.id));
    if (probes.length === 0) continue;
    rows[row.id] = {
      observations: probes.map((probe) => probe.name),
      async run() {
        for (const probe of probes) await replay(probe);
      },
    };
  }
  return rows;
}

/** Runs a scenario on the page and from a registered process, and fails naming every plane that failed. */
async function callOnPageAndHost(scenario: string, input: (origin: string) => Facts, check: (facts: Facts, where: string) => void): Promise<void> {
  const planes: Array<[string, () => Promise<Facts>]> = [
    ['page', async () => onPage('functionsCallableLocal', scenario, input((await browserSession()).url))],
    ['registered process', async () => inRegisteredProcess('functionsCallableLocal', scenario, input((await hostedSession()).url))],
  ];
  const failures: string[] = [];
  for (const [where, run] of planes) {
    try {
      check(await run(), where);
    } catch (error) {
      failures.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
}

function echoed(call: CallFacts): Facts {
  const value = expectResolved(call);
  return (value.data as { data: Facts }).data;
}

const ROWS: Record<string, RowAssertion> = {
  ...observedRows(),
  'functions-callable#9': {
    observations: [],
    async run() {
      const { targets } = await servingSession();
      const requests = await withTokens(['pyricCallableEcho', 'pyricCallableV1'].map((fn) => ({
        id: fn,
        function: fn,
        via: 'cloudfunctions' as const,
        tokens: { auth: 'expired' as const },
        ...callableBody({}),
      })));
      const responses = await sendProbe(requests, targets);
      for (const response of Object.values(responses)) {
        expect(response.status).toBe(401);
        expect((response.json as { error?: { status?: string } } | null)?.error?.status).toBe('UNAUTHENTICATED');
      }
    },
  },
  'functions-callable#19': {
    observations: [],
    async run() {
      await callOnPageAndHost('timeout', () => ({ region: REGION }), (facts) => {
        expectRejectedWith(facts.call as CallFacts, 'functions/deadline-exceeded');
      });
    },
  },
  'functions-callable#21': {
    observations: [],
    async run() {
      // The first call the page made as it loaded: answered, or unavailable while the child starts.
      const { page, beforePeer, output } = await browserSession();
      const firstCall = JSON.parse(await page.evaluate(async () => JSON.stringify(
        await (globalThis as unknown as { functionsCallableFirstCall: Promise<unknown> }).functionsCallableFirstCall,
      ))) as CallFacts;
      if (firstCall.threw) expectRejectedWith(firstCall, 'functions/unavailable');
      else expect(echoed(firstCall)).toEqual({ via: 'first-call' });
      // Before any peer connected: 503 with no callable {error} body, so the client maps it to unavailable.
      for (const response of Object.values(beforePeer)) {
        expect(response.status).toBe(503);
        expect((response.json as { error?: unknown } | null)?.error).toBeUndefined();
        expect(response.body).toMatch(/browser tab/i);
      }
      expect(output()).toMatch(/pyricCallableEcho/);
    },
  },
  'functions-callable#22': {
    observations: [],
    async run() {
      await callOnPageAndHost('adminWrite', () => ({ region: REGION, id: `row-22-${randomUUID()}` }), (facts, where) => {
        const call = facts.call as CallFacts;
        const id = (echoed(call) as { id: string }).id;
        const read = facts.read as { threw: boolean; message?: string; value?: { exists: boolean; data: unknown } };
        if (read.threw) throw new Error(`${where} read failed: ${read.message}`);
        expect(read.value).toEqual({ exists: true, data: { writtenBy: 'pyricCallableEcho', id } });
      });
    },
  },
  'functions-callable#23': {
    observations: [],
    async run() {
      const { url, output } = await servingSession();
      const linesOf = (name: string) => output().split('\n').filter((line) => line.includes(name) && /callable/i.test(line));
      const before = linesOf('pyricCallableEcho').length;
      const response = await sendProbeRequest(`${url}${functionPath('pyricCallableEcho')}`, {
        id: 'row-23', function: 'pyricCallableEcho', via: 'cloudfunctions', ...callableBody({ via: 'row-23' }),
      });
      expect(response.status).toBe(200);
      const after = await waitFor(() => (linesOf('pyricCallableEcho').length > before ? linesOf('pyricCallableEcho') : null), 2_000);
      expect(after).not.toBeNull();
      expect(after!.length - before).toBe(1);
      expect(after!.at(-1)).toContain('200');

      const streamBefore = linesOf('pyricCallableStream').length;
      const streamed = await sendProbeRequest(`${url}${functionPath('pyricCallableStream')}`, {
        id: 'row-23-stream',
        function: 'pyricCallableStream',
        via: 'cloudfunctions',
        ...callableBody({}),
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      });
      expect(streamed.status).toBe(200);
      await Bun.sleep(300);
      expect(linesOf('pyricCallableStream').length - streamBefore).toBe(1);
    },
  },
  'functions-callable#24': {
    observations: [],
    async run() {
      const { consoleLines } = await browserSession();
      await callOnPageAndHost('emulator', () => ({ region: REGION }), (facts) => {
        expectResolved(facts.accepted as CallFacts);
        expect(echoed(facts.call as CallFacts)).toEqual({ via: 'emulator' });
      });
      expect(consoleLines.filter((line) => /connectFunctionsEmulator/.test(line))).toHaveLength(1);
    },
  },
  'functions-callable#25': {
    observations: [],
    async run() {
      // Production AI mode serves the same firebase/functions entry as sandbox mode.
      expect(sdkImportMap('production')['firebase/functions']).toBe(sdkImportMap('sandbox')['firebase/functions']);
      // And that entry reaches the app's local callable.
      const facts = await onPage('functionsCallableLocal', 'echo', { region: REGION, via: 'row-25' });
      expect(echoed(facts.call as CallFacts)).toEqual({ via: 'row-25' });
    },
  },
};

/** Observations no row replays, each with the reason. */
const NOT_APPLICABLE: Record<string, string> = {};

afterAll(async () => {
  const started = await browserPlane?.catch(() => undefined);
  if (started) await started.browser.close().catch(() => undefined);
  const hosted = await hostedPlane?.catch(() => undefined);
  for (const plane of [started, hosted]) {
    const cliPid = plane?.command.pid;
    // Collect the children before the CLI dies: afterwards they are re-parented and unfindable by ppid.
    const children = cliPid === undefined ? [] : functionsChildrenOf(cliPid);
    if (plane?.command.exitCode === null) plane.command.kill('SIGKILL');
    for (const pid of children) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
});

for (const row of functionsCallableRows) {
  const assertion = ROWS[row.id];
  if (!assertion) continue;
  climbDescribe(`${row.id} ${row.api}`, () => {
    test(row.behavior, () => assertion.run(), 120_000);
  });
}

climbDescribe('functions-callable climb completeness', () => {
  test('every registry row has exactly one assertion set', () => {
    expect(Object.keys(ROWS).sort()).toEqual(functionsCallableRows.map((row) => row.id).sort());
  });

  test('every probe is replayed by a row or excused', () => {
    const replayedNames = new Set(Object.values(ROWS).flatMap((row) => row.observations));
    const unreplayed = functionsCallableProbes
      .map((probe) => probe.name)
      .filter((name) => !replayedNames.has(name) && !(name in NOT_APPLICABLE));
    expect(unreplayed).toEqual([]);
  });

  test('every committed functions-callable- observation is a probe this suite replays', () => {
    const probeNames = new Set(functionsCallableProbes.map((probe) => probe.name));
    const committed = existsSync(OBS_DIR)
      ? readdirSync(OBS_DIR).filter((file) => file.startsWith('functions-callable-') && file.endsWith('.json'))
      : [];
    const orphans = committed
      .map((file) => file.slice(0, -'.json'.length))
      .filter((name) => !probeNames.has(name) && !(name in NOT_APPLICABLE));
    expect(orphans).toEqual([]);
  });
});
