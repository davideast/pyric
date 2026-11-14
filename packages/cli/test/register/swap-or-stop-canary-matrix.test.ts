/**
 * Unified Swap-or-Stop guard canary matrix (ADR 0022, ADR 0023).
 *
 * Exercises adversarial bypass vectors across all six Swap-or-Stop enforcement
 * boundaries in one standing mechanical check:
 *   1. Next.js Edge runtime static AST detection
 *   2. Next.js client subpath aliases, hoisted monorepo Turbopack paths, and production AI mode
 *   3. Vite `#imports` client gate, non-production SSR builds, and process-stop lease lifecycle
 *   4. Register preload URL canonicalization across child processes and worker threads
 *   5. Sandbox child launcher inline environment protection and outer preload coexistence
 *   6. POSIX shell command-prefix builtin unwrapping for unsupported runtimes
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as viteBuild, createServer as createViteServer } from 'vite';
import {
  checkSandboxChildLaunch,
  detectUnsupportedRuntime,
  UNSUPPORTED_RUNTIME_CODE,
} from '../../src/cli/unsupported-runtime.js';
import { buildChildEnv, parseCommandString, spawnSandboxChild } from '../../src/cli/sandbox-runner.js';
import { findEdgeRuntimeFiles } from '../../src/next/edge-runtime.js';
import { clientStopTurbopackTarget, getClientStopSpecifiers } from '../../src/next/client-aliases.js';
import { augmentTurbopackConfig } from '../../src/next/turbopack-config.js';
import bridgeImportLoader from '../../src/next/bridge-import-loader.js';
import { bridgeImportOptions } from '../../src/next/bridge-imports.js';
import {
  loadsRegister,
  withCanonicalRegisterExecArgv,
  withCanonicalRegisterNodeOptions,
} from '../../src/register/child-process-guard.js';
import { installWorkerGuard } from '../../src/register/worker-guard.js';
import { pyric as pyricVite } from '../../src/serve/vite-plugin.js';
import {
  acquireViteLiveProcessStop,
  acquireViteProcessStop,
  type SyncResolve,
} from '../../src/serve/vite-process-stop.js';
import { suppliedRows } from '../../src/serve/vite-supplied-rows.js';

const requireFromHere = createRequire(import.meta.url);
const cliRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const registerDistPath = path.join(cliRoot, 'dist', 'register', 'index.js');
const registerDistUrl = pathToFileURL(registerDistPath).href;

const scratchDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function findInstalledPackageRoot(entrySpecifier: string, expectedName: string): string {
  let dir = path.dirname(requireFromHere.resolve(entrySpecifier));
  while (dir !== path.dirname(dir)) {
    const manifestPath = path.join(dir, 'package.json');
    try {
      const parsed = JSON.parse(requireFromHere('node:fs').readFileSync(manifestPath, 'utf8')) as { name?: string };
      if (parsed.name === expectedName) return dir;
    } catch {
      // Keep ascending until the package root is found.
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not locate installed root for ${expectedName}`);
}

describe('Swap-or-Stop standing guard canary matrix', () => {
  it('1. detects Next.js Edge runtime declarations across JSX, bindings, barrels, tsconfig paths, and generics', () => {
    const project = makeTempDir('pyric-canary-next-edge-');
    writeFileSync(
      path.join(project, 'tsconfig.base.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
    );
    writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({ extends: './tsconfig.base.json' }));

    mkdirSync(path.join(project, 'src', 'shared'), { recursive: true });
    writeFileSync(
      path.join(project, 'src', 'shared', 'edge-defs.ts'),
      "export const EDGE_MODE = 'edge' as const;\nexport const EDGE_CONFIG = { runtime: 'experimental-edge' };\n",
    );
    writeFileSync(
      path.join(project, 'src', 'shared', 'barrel.ts'),
      "export * from './edge-defs';\nexport { EDGE_CONFIG as config } from './edge-defs';\n",
    );

    mkdirSync(path.join(project, 'src', 'app', 'jsx-apostrophe'), { recursive: true });
    writeFileSync(
      path.join(project, 'src', 'app', 'jsx-apostrophe', 'page.tsx'),
      "export function Card() { return <div>It's active</div>; }\nexport const runtime = 'edge';\n",
    );

    mkdirSync(path.join(project, 'src', 'app', 'aliased-binding'), { recursive: true });
    writeFileSync(
      path.join(project, 'src', 'app', 'aliased-binding', 'route.ts'),
      "import { EDGE_MODE } from '@/shared/barrel';\nexport const runtime = EDGE_MODE;\n",
    );

    mkdirSync(path.join(project, 'src', 'app', 'reexported-config'), { recursive: true });
    writeFileSync(
      path.join(project, 'src', 'app', 'reexported-config', 'route.ts'),
      "export * from '@/shared/barrel';\n",
    );

    mkdirSync(path.join(project, 'src', 'app', 'generic-parens'), { recursive: true });
    writeFileSync(
      path.join(project, 'src', 'app', 'generic-parens', 'route.ts'),
      "const id = <K, V>(k: K, _v?: V): K => k;\nvoid id;\nexport const config = ({ runtime: 'edge' });\n",
    );

    mkdirSync(path.join(project, 'src', 'app', 'node-control'), { recursive: true });
    writeFileSync(
      path.join(project, 'src', 'app', 'node-control', 'route.ts'),
      "export const runtime = 'nodejs';\n",
    );

    const detected = findEdgeRuntimeFiles(project).sort();
    expect(detected).toEqual([
      'src/app/aliased-binding/route.ts',
      'src/app/generic-parens/route.ts',
      'src/app/jsx-apostrophe/page.tsx',
      'src/app/reexported-config/route.ts',
    ]);
  });

  it('2. enforces Next.js client subpath stops, hoisted Turbopack relative targets, and production AI SDK scoping', () => {
    const monorepoRoot = makeTempDir('pyric-canary-next-client-');
    const appDir = path.join(monorepoRoot, 'apps', 'web');
    mkdirSync(path.join(appDir, 'src'), { recursive: true });
    writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'web-app', private: true }));

    for (const [folder, pkgName, subpaths] of [
      ['firebase', 'firebase', { '.': './dist/index.mjs', './ai': './dist/index.mjs' }],
      ['@firebase/app', '@firebase/app', { '.': './dist/index.mjs' }],
      ['@firebase/ai', '@firebase/ai', { '.': './dist/index.mjs' }],
      ['@firebase/firestore', '@firebase/firestore', { '.': './dist/index.mjs', './lite': './dist/lite.mjs' }],
      ['aliased-firebase', 'firebase', { '.': './index.mjs', './firestore': './firestore.mjs' }],
    ] as const) {
      const pkgDir = path.join(monorepoRoot, 'node_modules', folder);
      mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
      writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: pkgName, version: '1.0.0', exports: subpaths }),
      );
      writeFileSync(path.join(pkgDir, 'dist', 'index.mjs'), "import '@firebase/app';\nexport const ok = 1;\n");
    }

    const prodStops = getClientStopSpecifiers('production', appDir);
    expect(prodStops).toContain('@firebase/app');
    expect(prodStops).toContain('@firebase/ai');
    expect(prodStops).toContain('@firebase/firestore/lite');
    expect(prodStops).toContain('aliased-firebase');
    expect(prodStops).toContain('aliased-firebase/firestore');

    const browserStopTarget = clientStopTurbopackTarget(appDir);
    expect(browserStopTarget.startsWith('/')).toBe(false);
    const augmented = augmentTurbopackConfig({});
    expect(augmented.turbopack).toBeDefined();

    const rewritten = bridgeImportLoader.call(
      {
        resourcePath: path.join(monorepoRoot, 'node_modules', '@firebase', 'ai', 'dist', 'index.mjs'),
        rootContext: monorepoRoot,
        getOptions: () => bridgeImportOptions(),
      },
      "import { _registerComponent } from '@firebase/app';\n",
    );
    expect(rewritten).not.toContain("'@firebase/app'");
  });

  it('3. enforces Vite #imports client stops, non-production SSR routing, and process-stop lease cleanup', async () => {
    const root = makeTempDir('pyric-canary-vite-');
    const firebaseDir = findInstalledPackageRoot('firebase/app', 'firebase');
    const adminDir = findInstalledPackageRoot('firebase-admin/app', 'firebase-admin');
    mkdirSync(path.join(root, 'node_modules', '@firebase', 'firestore'), { recursive: true });
    writeFileSync(
      path.join(root, 'node_modules', '@firebase', 'firestore', 'package.json'),
      JSON.stringify({ name: '@firebase/firestore', version: '4.0.0', type: 'module', exports: { '.': './index.js' } }),
    );
    writeFileSync(
      path.join(root, 'node_modules', '@firebase', 'firestore', 'index.js'),
      'export const getFirestore = () => ({});\n',
    );
    symlinkSync(firebaseDir, path.join(root, 'node_modules', 'firebase'), 'dir');
    symlinkSync(adminDir, path.join(root, 'node_modules', 'firebase-admin'), 'dir');

    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body></body></html>\n');
    writeFileSync(path.join(root, '.firebaserc'), JSON.stringify({ projects: { default: 'org-alpha' } }));
    writeFileSync(
      path.join(root, 'firestore.rules'),
      "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /items/{id} { allow read: if true; }\n  }\n}\n",
    );
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'vite-canary-app',
        private: true,
        type: 'module',
        imports: { '#direct-firestore': '@firebase/firestore' },
      }),
    );
    const ssrEntry = path.join(root, 'src', 'entry-server.js');
    writeFileSync(ssrEntry, "import { initializeApp } from 'firebase/app';\nexport const init = initializeApp;\n");

    const server = await createViteServer({
      root,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
      plugins: [pyricVite()],
    });
    try {
      const resolvedSubpath = await server.pluginContainer.resolveId('#direct-firestore', ssrEntry);
      expect(resolvedSubpath?.id).toStartWith('\0pyric-stop:');
    } finally {
      await server.close();
    }

    const ssrBuilt = await viteBuild({
      root,
      mode: 'development',
      logLevel: 'silent',
      build: { ssr: ssrEntry, write: false },
      plugins: [pyricVite()],
    });
    const outputs = Array.isArray(ssrBuilt) ? ssrBuilt[0]!.output : (ssrBuilt as { output: Array<{ code?: string }> }).output;
    const bundledCode = outputs.map((chunk) => ('code' in chunk && typeof chunk.code === 'string' ? chunk.code : '')).join('\n');
    expect(bundledCode).not.toContain('SharedWorker');
    expect(bundledCode).not.toContain('__PYRIC_DEV_RUNTIME__');
    expect(bundledCode).toContain('@pyric/cli/vite/ssr-loader');

    const installedHooks: Array<{ resolve: SyncResolve }> = [];
    const slot: Record<symbol, unknown> = {};
    const registerHooks = (hooks: { resolve: SyncResolve }) => void installedHooks.push(hooks);
    const releaseSandbox = acquireViteProcessStop({
      slot,
      registerHooks,
      registerActive: () => false,
      write: () => undefined,
    });
    const supplied = suppliedRows((specifier) =>
      Object.assign(new Error(`refused ${specifier}`), { code: 'PYRIC_LIVE_REFUSED' }),
    );
    const releaseLive = acquireViteLiveProcessStop(supplied, {
      slot,
      registerHooks,
      registerActive: () => false,
      write: () => undefined,
    });
    const realAdminUrl = pathToFileURL(requireFromHere.resolve('firebase-admin/app')).href;
    const resolveHook = installedHooks[0]!.resolve;
    let liveCode: string | undefined;
    try {
      resolveHook('firebase-admin/app', { parentURL: pathToFileURL(ssrEntry).href }, () => ({ url: realAdminUrl }));
    } catch (err) {
      liveCode = (err as { code?: string }).code;
    }
    expect(liveCode).toBe('PYRIC_LIVE_REFUSED');
    releaseSandbox();
    releaseLive();
    expect(
      resolveHook('firebase-admin/app', { parentURL: pathToFileURL(ssrEntry).href }, () => ({ url: realAdminUrl })),
    ).toEqual({ url: realAdminUrl });
  });

  it('4. canonicalizes register preloads across filesystem paths, file URLs, and Workers without eating user preloads', () => {
    const userPreload = '/opt/hooks/telemetry-register-preload.mjs';
    expect(loadsRegister(`--import ${userPreload}`, registerDistUrl)).toBe(false);
    expect(loadsRegister(`--import ${registerDistPath}`, registerDistUrl)).toBe(true);
    expect(loadsRegister('--import @pyric/cli/register', registerDistUrl)).toBe(true);

    const canonicalOptions = withCanonicalRegisterNodeOptions(
      `--import ${userPreload} --import=${registerDistPath}`,
      registerDistUrl,
    );
    expect(canonicalOptions).toContain(`--import ${userPreload}`);
    expect(canonicalOptions.match(/--import/g)).toHaveLength(2);

    const canonicalArgv = withCanonicalRegisterExecArgv(
      [`--import=${registerDistPath}`, `--import=${userPreload}`],
      registerDistUrl,
    );
    expect(canonicalArgv).toEqual([`--import=${registerDistUrl}`, `--import=${userPreload}`]);

    const capturedOptions: Array<Record<string, unknown> | undefined> = [];
    class FakeWorker {
      constructor(_filename: string | URL, options?: Record<string, unknown>) {
        capturedOptions.push(options);
      }
    }
    const target = { Worker: FakeWorker as unknown as typeof import('node:worker_threads').Worker };
    const prevNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--import ${userPreload}`;
    try {
      installWorkerGuard(registerDistUrl, target);
      new target.Worker(new URL('file:///app/worker.mjs'), {
        execArgv: [`--import=${registerDistPath}`],
        env: { NODE_OPTIONS: `--import ${userPreload}` },
      });
    } finally {
      if (prevNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prevNodeOptions;
    }
    const workerExecArgv = capturedOptions[0]?.execArgv as string[] | undefined;
    expect(workerExecArgv).toEqual([`--import=${registerDistUrl}`]);
    const workerEnv = capturedOptions[0]?.env as Record<string, string> | undefined;
    expect(workerEnv?.NODE_OPTIONS).toContain(`--import ${userPreload}`);
  });

  it('5. preserves sandbox activation env against inline shell overrides and coexists with outer *register* preloads', async () => {
    const dir = makeTempDir('pyric-canary-spawn-');
    const userPreload = path.join(dir, 'custom-register-hook.mjs');
    writeFileSync(userPreload, 'globalThis.__USER_REGISTER_HOOK__ = true;\n');
    const outFile = path.join(dir, 'out.json');
    const probeScript = path.join(dir, 'probe.mjs');
    writeFileSync(
      probeScript,
      [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({`,
        '  sandbox: process.env.PYRIC_SANDBOX,',
        '  token: process.env.PYRIC_SESSION_TOKEN,',
        '  custom: process.env.CUSTOM_FLAG,',
        '  userHook: Boolean(globalThis.__USER_REGISTER_HOOK__),',
        "  registerActive: Boolean(globalThis[Symbol.for('pyric.register.active')]),",
        '}));',
      ].join('\n'),
    );

    const childEnv = buildChildEnv(
      {
        ...process.env,
        NODE_OPTIONS: `--import ${pathToFileURL(userPreload).href}`,
      },
      {
        serveUrl: 'http://127.0.0.1:44100',
        registerUrl: registerDistUrl,
        sessionToken: 'expected-session-token',
      },
    );
    const argv = parseCommandString(
      `PYRIC_SANDBOX='' PYRIC_SESSION_TOKEN=forged CUSTOM_FLAG=kept node ${JSON.stringify(probeScript)}`,
    );
    const handle = spawnSandboxChild({ argv, label: 'probe' }, { cwd: dir, env: childEnv, json: true });
    const exitCode = await handle.exited;
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(requireFromHere('node:fs').readFileSync(outFile, 'utf8')) as Record<string, unknown>;
    expect(parsed).toEqual({
      sandbox: 'remote:http://127.0.0.1:44100',
      token: 'expected-session-token',
      custom: 'kept',
      userHook: true,
      registerActive: true,
    });
  });

  it('6. refuses unsupported runtimes wrapped in POSIX command-prefix builtins while allowing lookup-only command -v', () => {
    const blockedVectors: Array<[string[], 'bun' | 'deno']> = [
      [['sh', '-c', 'exec bun run dev'], 'bun'],
      [['sh', '-c', 'exec -a worker-proc bunx vite'], 'bun'],
      [['bash', '-lc', 'command deno run server.ts'], 'deno'],
      [['sh', '-c', 'command -p bun x next dev'], 'bun'],
      [['sh', '-c', 'eval "bun run start"'], 'bun'],
      [['sh', '-c', 'nohup nice -n 5 exec bun script.ts'], 'bun'],
    ];
    for (const [argv, expectedRuntime] of blockedVectors) {
      expect(detectUnsupportedRuntime(argv)).toBe(expectedRuntime);
      const lines: string[] = [];
      const stopped = checkSandboxChildLaunch({ argv }, 'pyric sandbox', {
        env: {},
        write: (line) => lines.push(line),
      });
      expect(stopped).toBe(true);
      expect(lines.join('')).toContain(UNSUPPORTED_RUNTIME_CODE);
    }
    expect(detectUnsupportedRuntime(['sh', '-c', 'command -v bun && node server.js'])).toBeNull();
  });
});
