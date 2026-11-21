/**
 * End-to-end local verification of all 7 `CALLABLE_BROWSER_SOURCE` client
 * scenarios on both the Chromium page (`pyric sandbox`) and a registered Node
 * process (`pyric sandbox --hosted` + `node --import @pyric/cli/register`),
 * plus Node-host `offHostRefusal` (decision 7) and ambiguous `run.app` service
 * warnings (decision 4).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import {
  CALLABLE_BROWSER_SOURCE,
  callableBody,
  functionsCallableCaptureDir,
  sendProbeRequest,
} from '@pyric/conformance/functions-callable-fixture';
import { mintCustomToken } from 'pyric/sandbox/internal';
import { createFunctionsHttpGateway } from '../../src/functions/http/gateway.js';
import { functionsChildrenOf, isAlive } from '../functions-http/children.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');
const PROJECT_ID = 'demo-functions-callable';
const REGION = 'us-central1';
const CUSTOM_TOKEN = mintCustomToken({
  uid: 'client-probe-user',
  projectId: PROJECT_ID,
  nowMs: Date.now(),
});
const WEB_CONFIG = {
  apiKey: 'pyric-callable-client-probes',
  projectId: PROJECT_ID,
  appId: '1:000000000000:web:0000000000000000',
};

const NODE_RUNNER = String.raw`
globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
await import('./callable-browser-source.mjs');
const [scenario, configJson, inputJson] = process.argv.slice(2);
try {
  const facts = await globalThis.functionsCallableProbes[scenario](JSON.parse(configJson), JSON.parse(inputJson));
  process.stdout.write('PYRIC_FACTS ' + JSON.stringify(facts) + '\n');
} catch (error) {
  process.stdout.write('PYRIC_THREW ' + JSON.stringify({ name: error?.name ?? null, message: String(error?.message ?? error) }) + '\n');
}
process.exit(0);
`;

interface Plane {
  cwd: string;
  url: string;
  command: ChildProcess;
  output(): string;
}

interface BrowserPlane extends Plane {
  browser: Browser;
  page: Page;
}

let nonHostedPlane: Promise<Plane> | undefined;
let browserPlane: Promise<BrowserPlane | null> | undefined;
let hostedPlane: Promise<Plane> | undefined;

async function waitFor<T>(
  read: () => T | null | Promise<T | null>,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(50);
  }
  return null;
}

function linkPackage(cwd: string, name: string, target: string): void {
  const link = join(cwd, 'node_modules', name);
  mkdirSync(resolve(link, '..'), { recursive: true });
  symlinkSync(target, link);
}

function stageFixture(label: string): string {
  const cwd = mkdtempSync(join(tmpdir(), `pyric-callable-client-${label}-`));
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
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'callable-client-probes', private: true, type: 'module' }),
  );
  writeFileSync(join(cwd, 'callable-browser-source.mjs'), CALLABLE_BROWSER_SOURCE);
  writeFileSync(join(cwd, 'callable-runner.mjs'), NODE_RUNNER);
  return cwd;
}

async function startPlane(label: string, flags: readonly string[]): Promise<Plane> {
  if (!existsSync(cliEntry)) throw new Error(`build the CLI first: ${cliEntry}`);
  const cwd = stageFixture(label);
  let output = '';
  const command = spawn(
    'node',
    [cliEntry, 'sandbox', ...flags, '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
    { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  command.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  command.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });

  const pointer = await waitFor(() => {
    const path = join(cwd, '.pyric/serve.json');
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as { url: string };
  }, 15_000);
  if (!pointer) throw new Error(`pyric sandbox did not start:\n${output}`);
  return { cwd, url: pointer.url.replace(/\/$/, ''), command, output: () => output };
}

async function waitForReady(url: string): Promise<void> {
  const ready = await waitFor(async () => {
    const res = await sendProbeRequest(`${url}/${PROJECT_ID}/${REGION}/pyricCallableEcho`, {
      id: 'ready',
      function: 'pyricCallableEcho',
      via: 'cloudfunctions',
      clientTimeoutMs: 2_000,
      ...callableBody({}),
    });
    if (res.status === 200) return true;
    return null;
  }, 30_000);
  if (!ready) throw new Error('pyricCallableEcho did not answer 200');
}

function getNonHostedPlane(): Promise<Plane> {
  if (nonHostedPlane === undefined) {
    nonHostedPlane = startPlane('browser', []);
  }
  return nonHostedPlane;
}

async function getBrowserPlane(): Promise<BrowserPlane | null> {
  if (!existsSync(chromium.executablePath())) {
    return null;
  }
  if (browserPlane === undefined) {
    browserPlane = (async () => {
      const plane = await getNonHostedPlane();
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      await context.addInitScript((token: string) => {
        (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
          token;
      }, randomUUID());
      const page = await context.newPage();
      await page.goto(`${plane.url}/`, { waitUntil: 'load' });
      await page.addScriptTag({ type: 'module', content: CALLABLE_BROWSER_SOURCE });
      await page.waitForFunction(
        () =>
          typeof (globalThis as unknown as Record<string, unknown>).functionsCallableProbes ===
          'object',
      );
      await waitForReady(plane.url);
      return { ...plane, browser, page };
    })();
  }
  return browserPlane;
}

async function getHostedPlane(): Promise<Plane> {
  if (hostedPlane === undefined) {
    hostedPlane = (async () => {
      const plane = await startPlane('hosted', ['--hosted', '--no-run']);
      await waitForReady(plane.url);
      return plane;
    })();
  }
  return hostedPlane;
}

async function runOnAvailablePlanes(
  scenario: string,
  buildInput: (origin: string) => Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  const browser = await getBrowserPlane();
  if (browser !== null) {
    const pageJson = await browser.page.evaluate(
      async ([name, cfg, inp]) => {
        const ns = (
          globalThis as unknown as {
            functionsCallableProbes: Record<
              string,
              (c: unknown, i: unknown) => Promise<Record<string, unknown>>
            >;
          }
        ).functionsCallableProbes;
        const fn = ns[name];
        if (!fn) throw new Error(`missing scenario ${name}`);
        return JSON.stringify(await fn(cfg, inp));
      },
      [scenario, WEB_CONFIG, buildInput(browser.url)] as const,
    );
    results.push(JSON.parse(pageJson) as Record<string, unknown>);
  }

  const host = await getHostedPlane();
  const child = spawn(
    'node',
    [
      '--import',
      '@pyric/cli/register',
      'callable-runner.mjs',
      scenario,
      JSON.stringify(WEB_CONFIG),
      JSON.stringify(buildInput(host.url)),
    ],
    {
      cwd: host.cwd,
      env: { ...process.env, PYRIC_SANDBOX: `remote:${host.url}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk;
  });
  const exited = await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return null;
  }, 60_000);
  if (!exited) child.kill('SIGKILL');
  const match = out.match(/^PYRIC_FACTS (.*)$/m);
  if (!match || !match[1]) {
    throw new Error(`registered process failed on ${scenario}:\n${out}`);
  }
  results.push(JSON.parse(match[1]) as Record<string, unknown>);
  return results;
}

afterAll(async () => {
  const browser = await browserPlane?.catch(() => undefined);
  if (browser) {
    await browser.browser.close().catch(() => undefined);
  }
  const nonHosted = await nonHostedPlane?.catch(() => undefined);
  const hosted = await hostedPlane?.catch(() => undefined);
  for (const plane of [nonHosted, hosted]) {
    const pid = plane?.command.pid;
    let children: number[] = [];
    if (pid !== undefined) {
      children = functionsChildrenOf(pid);
    }
    if (plane && plane.command.exitCode === null) {
      plane.command.kill('SIGKILL');
    }
    for (const childPid of children) {
      if (isAlive(childPid)) process.kill(childPid, 'SIGKILL');
    }
    if (plane) {
      rmSync(plane.cwd, { recursive: true, force: true });
    }
  }
});

describe('functions-callable client probes on browser page and registered Node host', () => {
  test('encoding, errors, fromUrl, and customDomain match across page and Node host', async () => {
    const encoding = await runOnAvailablePlanes('encoding', () => ({ region: REGION }));
    for (const facts of encoding) {
      expect((facts.nan as { threw: boolean }).threw).toBe(true);
      expect((facts.infinity as { threw: boolean }).threw).toBe(true);
      expect((facts.sent as { threw: boolean }).threw).toBe(false);
    }

    const errors = await runOnAvailablePlanes('errors', () => ({ region: REGION }));
    for (const facts of errors) {
      expect(facts.isFunctionsErrorName).toBe('FirebaseError');
      const missingFn = facts.missingFunction as {
        threw: boolean;
        code: string;
        customDataKeys: string[];
      };
      expect(missingFn.threw).toBe(true);
      expect(missingFn.code).toBe('functions/not-found');
      expect(missingFn.customDataKeys).toEqual(['url']);
    }

    const fromUrl = await runOnAvailablePlanes('fromUrl', () => ({
      region: REGION,
      urls: {
        cloudfunctions: `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/pyricCallableEcho`,
        run: 'https://pyriccallableecho-pyric-uc.a.run.app',
      },
    }));
    for (const facts of fromUrl) {
      expect((facts.cloudfunctions as { threw: boolean }).threw).toBe(false);
      expect((facts.run as { threw: boolean }).threw).toBe(false);
    }

    const customDomain = await runOnAvailablePlanes('customDomain', (origin) => ({
      region: REGION,
      customDomain: origin,
    }));
    for (const facts of customDomain) {
      expect((facts.call as { threw: boolean }).threw).toBe(false);
    }
  }, 120_000);

  test('limitedUse, stream, and signedIn match across page and Node host', async () => {
    const limitedUse = await runOnAvailablePlanes('limitedUse', () => ({ region: REGION }));
    for (const facts of limitedUse) {
      const first = facts.limitedFirst as { value?: { data?: { app?: { alreadyConsumed?: boolean } } } };
      const second = facts.limitedSecond as { value?: { data?: { app?: { alreadyConsumed?: boolean } } } };
      const cachedSecond = facts.cachedSecond as { value?: { data?: { app?: { alreadyConsumed?: boolean } } } };
      expect(first.value?.data?.app?.alreadyConsumed).toBe(false);
      expect(second.value?.data?.app?.alreadyConsumed).toBe(false);
      expect(cachedSecond.value?.data?.app?.alreadyConsumed).toBe(true);
    }

    const stream = await runOnAvailablePlanes('stream', () => ({ region: REGION }));
    for (const facts of stream) {
      const ok = facts.chunks as { value?: { chunks?: unknown[]; result?: { value?: { acceptsStreaming?: boolean } } } };
      expect(ok.value?.chunks).toEqual(['one', 'two', 'three']);
      expect(ok.value?.result?.value?.acceptsStreaming).toBe(true);
      const failing = facts.failing as {
        value?: {
          chunks?: unknown[];
          streamOutcome?: { threw?: boolean; code?: string; message?: string };
          result?: { threw?: boolean; code?: string };
        };
      };
      expect(failing.value?.chunks).toEqual(['one']);
      expect(failing.value?.streamOutcome?.threw).toBe(true);
      expect(failing.value?.streamOutcome?.code).toBe('functions/failed-precondition');
      expect(failing.value?.streamOutcome?.message).toContain('[0]');
      expect(failing.value?.result?.code).toBe('functions/failed-precondition');
    }

    const signedIn = await runOnAvailablePlanes('signedIn', () => ({
      region: REGION,
      customToken: CUSTOM_TOKEN,
    }));
    for (const facts of signedIn) {
      const v2 = facts.v2 as { value?: { data?: { auth?: { present?: boolean } } } };
      const v1 = facts.v1 as { value?: { data?: { auth?: { present?: boolean } } } };
      const signedOut = facts.signedOut as { value?: { data?: { auth?: { present?: boolean } } } };
      expect(v2.value?.data?.auth?.present).toBe(true);
      expect(v1.value?.data?.auth?.present).toBe(true);
      expect(signedOut.value?.data?.auth?.present).toBe(false);
    }
  }, 120_000);

  test('refuses a registered Node process targeting a non-hosted browser plane (offHostRefusal)', async () => {
    const nonHosted = await getNonHostedPlane();
    const child = spawn(
      'node',
      [
        '--import',
        '@pyric/cli/register',
        'callable-runner.mjs',
        'customDomain',
        JSON.stringify(WEB_CONFIG),
        JSON.stringify({ region: REGION, customDomain: nonHosted.url }),
      ],
      {
        cwd: nonHosted.cwd,
        env: { ...process.env, PYRIC_SANDBOX: `remote:${nonHosted.url}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
    });
    await waitFor(() => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      return null;
    }, 30_000);
    const match = out.match(/^PYRIC_FACTS (.*)$/m);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match?.[1] ?? '{}') as { call?: { threw?: boolean; message?: string } };
    expect(parsed.call?.threw).toBe(true);
    expect(parsed.call?.message).toMatch(/is not the Node host/);
  }, 60_000);

  test('warns once when a lowercased run.app service name matches multiple onCall exports', async () => {
    const warnings: string[] = [];
    const gateway = createFunctionsHttpGateway({
      projectId: PROJECT_ID,
      plane: 'hosted',
      onWarning: (msg) => warnings.push(msg),
      initial: {
        kind: 'ready',
        http: {
          port: 1,
          token: 'unused',
          functions: [
            {
              exportName: 'echoItem',
              kind: 'callable',
              regions: [REGION],
              platform: 'gcfv2',
              privateInvoker: false,
              timeoutSeconds: null,
            },
            {
              exportName: 'EchoItem',
              kind: 'callable',
              regions: [REGION],
              platform: 'gcfv2',
              privateInvoker: false,
              timeoutSeconds: null,
            },
          ],
        },
      },
    });
    const fakeRes = {
      headersSent: false,
      writableEnded: false,
      writeHead() {
        return this;
      },
      end() {
        this.writableEnded = true;
      },
    };
    const fakeReq = {
      url: `/${PROJECT_ID}/${REGION}/echoitem?__pyric_run_service=1`,
      method: 'POST',
      headers: { host: '127.0.0.1:5173' },
      pipe() {},
      on() {},
    };
    await gateway.handle(fakeReq as never, fakeRes as never, () => true).catch(() => undefined);
    await gateway.handle(fakeReq as never, fakeRes as never, () => true).catch(() => undefined);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("run.app service 'echoitem' matches multiple onCall exports (echoItem, EchoItem)");
  });
});
