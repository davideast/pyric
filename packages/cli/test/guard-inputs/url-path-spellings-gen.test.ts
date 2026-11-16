/**
 * Generative verification of Vite `/@fs` and root-relative URL path equivalence
 * spellings across:
 *  - Sensitive project state & `.env` files (direct and symlinked, `/` and `/app/` base)
 *  - Installed `node_modules` Firebase SDK bundles in `pyric()` and `pyricLive()`
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachLiveSdkRequestGate } from '../../src/serve/vite-live-sdk-requests.js';
import type { RowModulePackage } from '../../src/serve/vite-live-package.js';
import { suppliedRows } from '../../src/serve/vite-supplied-rows.js';
import { generateEquivalentViteUrls, type GeneratedUrlPathCase } from './url-path-spellings-gen.js';

const cliPkgDir = resolve(import.meta.dir, '../..');
const repoDir = resolve(cliPkgDir, '../..');
const cliViteDistUrl = pathToFileURL(realpathSync(join(cliPkgDir, 'dist/vite.js'))).href;
const liveViteDistUrl = pathToFileURL(
  realpathSync(join(repoDir, 'packages/live/dist/vite.js')),
).href;
const liveRequire = createRequire(realpathSync(join(repoDir, 'packages/live/package.json')));
const viteEntryUrl = pathToFileURL(
  join(dirname(liveRequire.resolve('vite/package.json')), 'dist/node/index.js'),
).href;
const nodeBin = process.env.PYRIC_TEST_NODE ?? 'node';

const SECRET_SERVE_SENTINEL = 'SYNTHETIC_SERVE_TOKEN_VALUE';
const SECRET_ENV_SENTINEL = 'SYNTHETIC_ENV_SECRET_VALUE';
const FIREBASE_APP_SENTINEL = 'REAL_FIREBASE_APP_BODY_SENTINEL';
const SCOPED_SDK_SENTINEL = 'REAL_SCOPED_FIRESTORE_SDK_SENTINEL';

const VITE_PROBE_PREAMBLE = [
  'function rawGet(port, target) {',
  '  return new Promise((resP, rejP) => {',
  '    const req = request({ hostname: "127.0.0.1", port, path: target, headers: { accept: "text/javascript, text/plain, */*", connection: "close" }, agent: false }, (res) => {',
  '      let body = ""; res.setEncoding("utf8");',
  '      res.on("data", (d) => { body += d; });',
  '      res.on("end", () => resP({ status: res.statusCode ?? 0, body }));',
  '    });',
  '    req.on("error", rejP); req.end();',
  '  });',
  '}',
  'async function runPool(items, fn) {',
  '  let idx = 0;',
  '  async function worker() {',
  '    while (idx < items.length) { const cur = idx; idx += 1; await fn(items[cur], cur); }',
  '  }',
  '  await Promise.all(Array.from({ length: Math.min(16, items.length) }, () => worker()));',
  '}',
  'function readListeningPort(server) {',
  '  const addr = server.httpServer?.address();',
  '  if (addr && typeof addr === "object") return addr.port;',
  '  return 0;',
  '}',
].join('\n');

const scratchDirs: string[] = [];

interface ViteGuardFixture {
  readonly root: string;
  readonly publicDir: string;
  readonly serveJsonFile: string;
  readonly envFile: string;
  readonly serveLinkFile: string;
  readonly envLinkFile: string;
  readonly pubEnvLinkFile: string;
  readonly firebaseAppFile: string;
  readonly scopedFirestoreFile: string;
}

function createViteGuardFixture(): ViteGuardFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-gen-url-paths-')));
  const publicDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-gen-url-pub-')));
  scratchDirs.push(root, publicDir);

  mkdirSync(join(root, '.pyric'), { recursive: true });
  const serveJsonFile = join(root, '.pyric', 'serve.json');
  const envFile = join(root, '.env');
  writeFileSync(envFile, `APP_SECRET=${SECRET_ENV_SENTINEL}\n`);

  const serveLinkFile = join(root, 'serve-link.json');
  const envLinkFile = join(root, 'env-link');
  const pubEnvLinkFile = join(publicDir, 'pub-env-link');
  symlinkSync(envFile, envLinkFile);
  symlinkSync(envFile, pubEnvLinkFile);

  const fbDir = join(root, 'node_modules', 'firebase');
  mkdirSync(fbDir, { recursive: true });
  writeFileSync(
    join(fbDir, 'package.json'),
    JSON.stringify({ name: 'firebase', version: '12.19.0', type: 'module' }),
  );
  const firebaseAppFile = join(fbDir, 'firebase-app.js');
  writeFileSync(
    firebaseAppFile,
    `export function initializeApp() { return "${FIREBASE_APP_SENTINEL}"; }\n`,
  );

  const scopedDir = join(root, 'node_modules', '@firebase', 'firestore', 'dist');
  mkdirSync(scopedDir, { recursive: true });
  writeFileSync(
    join(root, 'node_modules', '@firebase', 'firestore', 'package.json'),
    JSON.stringify({ name: '@firebase/firestore', type: 'module' }),
  );
  const scopedFirestoreFile = join(scopedDir, 'index.esm.js');
  writeFileSync(scopedFirestoreFile, `export const marker = "${SCOPED_SDK_SENTINEL}";\n`);
  symlinkSync(scopedFirestoreFile, join(publicDir, 'sdk-pub-link.js'));

  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.js'), 'export const appEntryOk = true;\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'items-web', type: 'module' }));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>items</body></html>');
  writeFileSync(
    join(root, '.firebaserc'),
    JSON.stringify({ projects: { default: 'demo-project' } }),
  );

  return {
    root,
    publicDir,
    serveJsonFile,
    envFile,
    serveLinkFile,
    envLinkFile,
    pubEnvLinkFile,
    firebaseAppFile,
    scopedFirestoreFile,
  };
}

interface SandboxViteProbeResult {
  readonly controlStatus: number;
  readonly sensitiveFailures: string[];
  readonly sdkFailures: string[];
}

function runSandboxViteNodeProbe(input: {
  fixture: ViteGuardFixture;
  base: string;
  controlPath: string;
  sensitiveCases: readonly GeneratedUrlPathCase[];
  sdkCases: readonly GeneratedUrlPathCase[];
  includeWhatwgFetch: boolean;
}): Promise<SandboxViteProbeResult> {
  const probeScript = join(input.fixture.root, 'run-sandbox-vite-url-probe.mjs');
  writeFileSync(
    probeScript,
    [
      'import { symlinkSync, writeFileSync } from "node:fs";',
      'import { request } from "node:http";',
      VITE_PROBE_PREAMBLE,
      `const { createServer } = await import(${JSON.stringify(viteEntryUrl)});`,
      `const { pyric } = await import(${JSON.stringify(cliViteDistUrl)});`,
      `const cfg = ${JSON.stringify({
        root: input.fixture.root,
        publicDir: input.fixture.publicDir,
        serveJsonFile: input.fixture.serveJsonFile,
        serveLinkFile: input.fixture.serveLinkFile,
        firebaseAppFile: input.fixture.firebaseAppFile,
        base: input.base,
        controlPath: input.controlPath,
        sensitiveCases: input.sensitiveCases,
        sdkCases: input.sdkCases,
        includeWhatwgFetch: input.includeWhatwgFetch,
        serveSentinel: SECRET_SERVE_SENTINEL,
        envSentinel: SECRET_ENV_SENTINEL,
        appSentinel: FIREBASE_APP_SENTINEL,
        scopedSentinel: SCOPED_SDK_SENTINEL,
      })};`,
      'const server = await createServer({',
      '  root: cfg.root, publicDir: cfg.publicDir, base: cfg.base, configFile: false, logLevel: "silent",',
      '  server: { host: "127.0.0.1", port: 0, strictPort: false, ws: false },',
      '  optimizeDeps: { noDiscovery: true, include: [] },',
      '  plugins: [pyric({ ui: false, project: "demo-project" })],',
      '});',
      'try {',
      '  await server.listen();',
      '  writeFileSync(cfg.serveJsonFile, JSON.stringify({ token: cfg.serveSentinel }));',
      '  symlinkSync(cfg.serveJsonFile, cfg.serveLinkFile);',
      '  const port = readListeningPort(server);',
      '  const sensitiveFailures = [];',
      '  const sdkFailures = [];',
      '  await runPool(cfg.sensitiveCases, async (c) => {',
      '    const ans = await rawGet(port, c.rawTarget);',
      '    const leaked = ans.body.includes(cfg.serveSentinel) || ans.body.includes(cfg.envSentinel);',
      '    if (ans.status !== 403 || leaked) {',
      '      sensitiveFailures.push(`${cfg.base} ${c.id} (${c.rawTarget}): status=${ans.status}, leaked=${leaked}`);',
      '    }',
      '  });',
      '  await runPool(cfg.sdkCases, async (c) => {',
      '    const ans = await rawGet(port, c.rawTarget);',
      '    const stopped = ans.status === 200 && ans.body.startsWith("throw Object.assign(new Error(") && ans.body.includes("PYRIC_REAL_SDK_STOPPED");',
      '    const leaked = ans.body.includes(cfg.appSentinel) || ans.body.includes(cfg.scopedSentinel);',
      '    if (!stopped || leaked) {',
      '      sdkFailures.push(`pyric(${cfg.base}) ${c.id}: status=${ans.status}, stopped=${stopped}, leaked=${leaked}`);',
      '    }',
      '  });',
      '  if (cfg.includeWhatwgFetch) {',
      '    const fSens = await fetch(`http://127.0.0.1:${port}//@fs${cfg.serveLinkFile}`);',
      '    const fSensBody = await fSens.text();',
      '    if (fSens.status !== 403 || fSensBody.includes(cfg.serveSentinel)) {',
      '      sensitiveFailures.push(`fetch //@fs serve-link: status=${fSens.status}`);',
      '    }',
      '    const fSdk = await fetch(`http://127.0.0.1:${port}//@fs${cfg.firebaseAppFile}`);',
      '    const fSdkBody = await fSdk.text();',
      '    if (!fSdkBody.includes("PYRIC_REAL_SDK_STOPPED") || fSdkBody.includes(cfg.appSentinel)) {',
      '      sdkFailures.push(`fetch //@fs firebase-app.js: status=${fSdk.status}`);',
      '    }',
      '  }',
      '  const controlStatus = (await rawGet(port, cfg.controlPath)).status;',
      '  console.log("SANDBOX_URL_REPORT " + JSON.stringify({ controlStatus, sensitiveFailures, sdkFailures }));',
      '} finally {',
      '  server.httpServer?.closeAllConnections?.();',
      '  await server.close();',
      '}',
    ].join('\n'),
  );

  return runNodeJsonProbe<SandboxViteProbeResult>(
    probeScript,
    input.fixture.root,
    'SANDBOX_URL_REPORT ',
  );
}

function runLiveViteNodeProbe(
  fixture: ViteGuardFixture,
  cases: readonly GeneratedUrlPathCase[],
): Promise<Array<{ id: string; status: number; refused: boolean; leaked: boolean }>> {
  const probeScript = join(fixture.root, 'run-live-vite-url-probe.mjs');
  writeFileSync(
    probeScript,
    [
      'import { request } from "node:http";',
      VITE_PROBE_PREAMBLE,
      `const { createServer } = await import(${JSON.stringify(viteEntryUrl)});`,
      `const { pyricLive } = await import(${JSON.stringify(liveViteDistUrl)});`,
      `const root = ${JSON.stringify(fixture.root)};`,
      `const publicDir = ${JSON.stringify(fixture.publicDir)};`,
      `const cases = ${JSON.stringify(cases)};`,
      `const appSentinel = ${JSON.stringify(FIREBASE_APP_SENTINEL)};`,
      `const scopedSentinel = ${JSON.stringify(SCOPED_SDK_SENTINEL)};`,
      'const server = await createServer({',
      '  root, publicDir, configFile: false, logLevel: "silent",',
      '  server: { host: "127.0.0.1", port: 0, strictPort: false, ws: false },',
      '  optimizeDeps: { noDiscovery: true, include: [] },',
      '  plugins: [pyricLive({ ui: false, project: "demo-project" })],',
      '});',
      'try {',
      '  await server.listen();',
      '  const port = readListeningPort(server);',
      '  const out = new Array(cases.length);',
      '  await runPool(cases, async (c, cur) => {',
      '    const ans = await rawGet(port, c.rawTarget);',
      '    const refused = ans.status === 200 && ans.body.startsWith("throw Object.assign(new Error(") && ans.body.includes("PYRIC_LIVE_REFUSED");',
      '    const leaked = ans.body.includes(appSentinel) || ans.body.includes(scopedSentinel);',
      '    out[cur] = { id: c.id, status: ans.status, refused, leaked };',
      '  });',
      '  const fetched = await fetch(`http://127.0.0.1:${port}//@fs${cases[0].rawTarget.replace(/^\\/@fs/, "")}`);',
      '  const fBody = await fetched.text();',
      '  out.push({ id: "whatwg-fetch-double-slash", status: fetched.status, refused: fBody.includes("PYRIC_LIVE_REFUSED"), leaked: fBody.includes(appSentinel) || fBody.includes(scopedSentinel) });',
      '  console.log("LIVE_URL_REPORT " + JSON.stringify(out));',
      '} finally {',
      '  server.httpServer?.closeAllConnections?.();',
      '  await server.close();',
      '}',
    ].join('\n'),
  );

  return runNodeJsonProbe(probeScript, fixture.root, 'LIVE_URL_REPORT ');
}

function runNodeJsonProbe<T>(scriptPath: string, cwd: string, prefix: string): Promise<T> {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(nodeBin, [scriptPath], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });
    child.once('error', rejectProbe);
    child.once('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith(prefix));
      if (code !== 0 || line === undefined) {
        rejectProbe(
          new Error(`Vite URL probe failed (${String(code)}):\n${stderr}\n${stdout}`),
        );
        return;
      }
      resolveProbe(JSON.parse(line.slice(prefix.length)) as T);
    });
  });
}

let sensitiveFailures: string[] = [];
let sandboxSdkFailures: string[] = [];
let rootControlStatus = 0;
let baseControlStatus = 0;
let liveSubprocessReport: Array<{ id: string; status: number; refused: boolean; leaked: boolean }> = [];
let standInFixture: ViteGuardFixture | undefined;

beforeAll(async () => {
  const rootFx = createViteGuardFixture();
  const baseFx = createViteGuardFixture();
  const liveFx = createViteGuardFixture();
  standInFixture = rootFx;

  const sensitiveRoot = [
    ...generateEquivalentViteUrls({
      absFilePath: rootFx.serveJsonFile,
      rootRelativePath: '.pyric/serve.json',
    }),
    ...generateEquivalentViteUrls({ absFilePath: rootFx.envFile, rootRelativePath: '.env' }),
    ...generateEquivalentViteUrls({
      absFilePath: rootFx.serveLinkFile,
      rootRelativePath: 'serve-link.json',
    }),
    ...generateEquivalentViteUrls({ absFilePath: rootFx.envLinkFile, rootRelativePath: 'env-link' }),
    ...generateEquivalentViteUrls({
      absFilePath: rootFx.pubEnvLinkFile,
      rootRelativePath: 'pub-env-link',
    }),
  ];
  const sdkRoot = [
    ...generateEquivalentViteUrls({
      absFilePath: rootFx.firebaseAppFile,
      rootRelativePath: 'node_modules/firebase/firebase-app.js',
    }),
    ...generateEquivalentViteUrls({
      absFilePath: rootFx.scopedFirestoreFile,
      rootRelativePath: 'sdk-pub-link.js',
    }),
  ];

  const sensitiveBase = [
    ...generateEquivalentViteUrls({
      absFilePath: baseFx.serveJsonFile,
      rootRelativePath: '.pyric/serve.json',
      base: '/app/',
    }),
    ...generateEquivalentViteUrls({
      absFilePath: baseFx.serveLinkFile,
      rootRelativePath: 'serve-link.json',
      base: '/app/',
    }),
  ];
  const sdkBase = generateEquivalentViteUrls({
    absFilePath: baseFx.firebaseAppFile,
    rootRelativePath: 'node_modules/firebase/firebase-app.js',
    base: '/app/',
  });

  const liveCases = [
    ...generateEquivalentViteUrls({
      absFilePath: liveFx.firebaseAppFile,
      rootRelativePath: 'node_modules/firebase/firebase-app.js',
    }),
    ...generateEquivalentViteUrls({
      absFilePath: liveFx.scopedFirestoreFile,
      rootRelativePath: 'sdk-pub-link.js',
    }),
  ];

  const [rootRes, baseRes, liveRes] = await Promise.all([
    runSandboxViteNodeProbe({
      fixture: rootFx,
      base: '/',
      controlPath: '/src/main.js',
      sensitiveCases: sensitiveRoot,
      sdkCases: sdkRoot,
      includeWhatwgFetch: true,
    }),
    runSandboxViteNodeProbe({
      fixture: baseFx,
      base: '/app/',
      controlPath: '/app/src/main.js',
      sensitiveCases: sensitiveBase,
      sdkCases: sdkBase,
      includeWhatwgFetch: false,
    }),
    runLiveViteNodeProbe(liveFx, liveCases),
  ]);

  rootControlStatus = rootRes.controlStatus;
  baseControlStatus = baseRes.controlStatus;
  sensitiveFailures = [...rootRes.sensitiveFailures, ...baseRes.sensitiveFailures];
  sandboxSdkFailures = [...rootRes.sdkFailures, ...baseRes.sdkFailures];
  liveSubprocessReport = liveRes;
}, 90_000);

afterAll(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Vite URL path equivalence grammar (/@fs, symlinks, and SDK bundles)', () => {
  it('7. denies all generated URL path spellings targeting direct and symlinked .pyric/serve.json and .env files (root and /app/ base)', () => {
    expect(rootControlStatus).toBe(200);
    expect(baseControlStatus).toBe(200);
    expect(sensitiveFailures).toEqual([]);
  });

  it('8a. rewrites all generated URL path spellings targeting real Firebase SDK files to stop modules in pyric()', () => {
    expect(sandboxSdkFailures).toEqual([]);
  });

  it('8b. refuses all generated URL path spellings targeting real and row-loaded Firebase SDK files in pyricLive()', async () => {
    const failures: string[] = [];
    for (const entry of liveSubprocessReport) {
      if (!entry.refused || entry.leaked) {
        failures.push(
          `pyricLive() ${entry.id}: status=${String(entry.status)}, refused=${String(entry.refused)}, leaked=${String(entry.leaked)}`,
        );
      }
    }

    const fx = standInFixture;
    if (fx === undefined) throw new Error('fixture missing');
    const writtenUrl = '/node_modules/@firebase/firestore/dist/index.esm.js?v=abc123';
    let gateMiddleware: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | undefined;
    const node = { url: writtenUrl, lastHMRTimestamp: 0 };
    const scopedSet = new Set([node]);
    const moduleGraph = {
      urlToModuleMap: new Map([[writtenUrl, node]]),
      getModulesByFile: (file: string) => {
        if (file === fx.scopedFirestoreFile) return scopedSet;
        return undefined;
      },
    };
    const standInServer = {
      config: {
        root: fx.root,
        publicDir: fx.publicDir,
        base: '/',
        cacheDir: join(fx.root, 'node_modules/.vite'),
      },
      middlewares: {
        use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => {
          gateMiddleware = fn;
        },
      },
      environments: { client: { moduleGraph } },
    };
    const rows = suppliedRows((spec) =>
      Object.assign(new Error(`@pyric/live: ${spec} is refused in live mode.`), {
        code: 'PYRIC_LIVE_REFUSED',
      }),
    );
    rows.open({} as unknown as RowModulePackage);
    rows.liveSdkUrls.add(pathToFileURL(fx.scopedFirestoreFile).href);
    attachLiveSdkRequestGate(
      standInServer as unknown as Parameters<typeof attachLiveSdkRequestGate>[0],
      rows,
    );

    const probeLoadedGate = (url: string): Promise<{ passed: boolean; threw: boolean }> =>
      new Promise((resP) => {
        const mockRes = {
          statusCode: 0,
          setHeader: () => undefined,
          end: () => resP({ passed: false, threw: false }),
        };
        if (gateMiddleware === undefined) {
          resP({ passed: true, threw: false });
          return;
        }
        try {
          gateMiddleware({ url } as IncomingMessage, mockRes as unknown as ServerResponse, () =>
            resP({ passed: true, threw: false }),
          );
        } catch {
          resP({ passed: false, threw: true });
        }
      });

    const writtenOutcome = await probeLoadedGate(writtenUrl);
    if (!writtenOutcome.passed || writtenOutcome.threw) {
      failures.push('loaded live-row canonical writtenUrl was unexpectedly refused');
    }
    const loadedVariants = [
      ...generateEquivalentViteUrls({
        absFilePath: fx.scopedFirestoreFile,
        rootRelativePath: 'node_modules/@firebase/firestore/dist/index.esm.js',
      }),
      ...generateEquivalentViteUrls({
        absFilePath: fx.scopedFirestoreFile,
        rootRelativePath: 'sdk-pub-link.js',
      }),
    ];
    for (const variant of loadedVariants) {
      if (variant.rawTarget === writtenUrl) continue;
      const outcome = await probeLoadedGate(variant.rawTarget);
      if (outcome.passed || outcome.threw) {
        const action = outcome.threw ? 'crashed on' : 'allowed';
        failures.push(`loaded live-row gate ${action} ${variant.id}: ${variant.rawTarget}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
