/**
 * Unified Swap-or-Stop guard canary matrix (ADR 0022, ADR 0023).
 *
 * Exercises adversarial bypass vectors across all six Swap-or-Stop enforcement
 * boundaries in one standing mechanical check:
 *   1. Next.js Edge runtime static AST & fail-closed detection
 *   2. Next.js client subpath aliases, hoisted monorepo Turbopack/Webpack rules, and production AI SDK scoping
 *   3. Vite `#imports` & plugin-alias client gate, non-production SSR builds, and `server.close()` process-stop cleanup
 *   4. Register preload URL canonicalization (`--import` and `-r`/`--require`), cross-register isolation, and custom-`env` Workers
 *   5. Sandbox child launcher inline `KEY=VAL` & `env -u` protection and outer preload coexistence
 *   6. POSIX shell command-prefix builtins, command substitutions, and shell flags for unsupported runtimes
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as viteBuild } from 'vite';
import {
  checkSandboxChildLaunch,
  detectUnsupportedRuntime,
  UNSUPPORTED_RUNTIME_CODE,
} from '../../src/cli/unsupported-runtime.js';
import { buildChildEnv, spawnSandboxChild } from '../../src/cli/sandbox-runner.js';
import { findEdgeRuntimeFiles } from '../../src/next/edge-runtime.js';
import { CLIENT_STOP_MODULE, clientStopTurbopackTarget, getClientStopSpecifiers } from '../../src/next/client-aliases.js';
import { augmentTurbopackConfig } from '../../src/next/turbopack-config.js';
import { augmentWebpackConfig } from '../../src/next/webpack-config.js';
import bridgeImportLoader from '../../src/next/bridge-import-loader.js';
import {
  BRIDGE_IMPORT_LOADER,
  PRODUCTION_AI_SDK_FILE_PATTERN,
  bridgeImportOptions,
  bridgeModuleFileNames,
} from '../../src/next/bridge-imports.js';
import {
  loadsRegister,
  withCanonicalRegisterExecArgv,
  withCanonicalRegisterNodeOptions,
} from '../../src/register/child-process-guard.js';
import { installWorkerGuard } from '../../src/register/worker-guard.js';
import { pyric as pyricVite } from '../../src/serve/vite-plugin.js';

const requireFromHere = createRequire(import.meta.url);
const cliRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const workspaceRoot = path.resolve(cliRoot, '../..');
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
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
      if (parsed.name === expectedName) return dir;
    } catch {
      // Keep ascending until the package root is found.
    }
    dir = path.dirname(dir);
  }
  throw new Error(`Could not locate installed root for ${expectedName}`);
}

describe('Swap-or-Stop standing guard canary matrix', () => {
  it('1. detects Next.js Edge runtime declarations across JSX, bindings, barrels, enums, tsconfig paths, and fail-closed broken modules', () => {
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
      "enum Mode { Edge = 'edge' }\nconst id = <K, V>(k: K, _v?: V): K => k;\nvoid id;\nexport const config = ({ runtime: Mode.Edge });\n",
    );

    mkdirSync(path.join(project, 'src', 'app', 'unresolved-fail-closed'), { recursive: true });
    writeFileSync(
      path.join(project, 'src', 'app', 'unresolved-fail-closed', 'route.ts'),
      "export { runtime } from './missing-config';\n",
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
      'src/app/unresolved-fail-closed/route.ts',
    ]);
  });

  it('2. enforces Next.js client subpath stops, hoisted Turbopack & Webpack rules, and production AI SDK scoping', () => {
    const monorepoRoot = makeTempDir('pyric-canary-next-client-');
    const appDir = path.join(monorepoRoot, 'apps', 'web');
    mkdirSync(path.join(appDir, 'src'), { recursive: true });
    writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'web-app', private: true }));
    mkdirSync(path.join(monorepoRoot, 'node_modules', '@pyric'), { recursive: true });
    symlinkSync(cliRoot, path.join(monorepoRoot, 'node_modules', '@pyric', 'cli'), 'dir');

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

    const browserStopTarget = clientStopTurbopackTarget();
    expect(browserStopTarget.startsWith('/')).toBe(false);
    const resolvedFromHoistedApp = Bun.resolveSync(browserStopTarget, appDir);
    expect(realpathSync(resolvedFromHoistedApp)).toBe(
      realpathSync(path.join(cliRoot, 'dist', 'next', 'client-stop.js')),
    );

    const prevAiMode = process.env.PYRIC_AI_MODE;
    process.env.PYRIC_AI_MODE = 'production';
    try {
      const turbopack = augmentTurbopackConfig({}).turbopack as Record<string, unknown>;
      const resolveAlias = turbopack.resolveAlias as Record<string, { browser: string }>;
      expect(resolveAlias['@firebase/firestore/lite']).toEqual({ browser: browserStopTarget });
      expect(resolveAlias['@firebase/app']).toEqual({ browser: browserStopTarget });
      const turboRules = turbopack.rules as Record<string, { loaders: Array<{ loader: string }> }>;
      for (const ruleName of bridgeModuleFileNames()) {
        expect(turboRules[ruleName]?.loaders[0]?.loader).toBe(BRIDGE_IMPORT_LOADER);
      }

      const webpackCfg = augmentWebpackConfig({});
      const clientWebpack = webpackCfg.webpack!(
        { resolve: {}, module: { rules: [] } },
        { isServer: false },
      ) as {
        resolve: { alias: Record<string, string> };
        module: { rules: Array<{ test: unknown; use: Array<{ loader: string; options?: unknown }> }> };
      };
      expect(clientWebpack.resolve.alias['@firebase/firestore/lite$']).toBe(CLIENT_STOP_MODULE);
      expect(clientWebpack.resolve.alias['@firebase/app$']).toBe(CLIENT_STOP_MODULE);
      expect(clientWebpack.module.rules).toEqual([
        {
          test: [...Object.keys(bridgeImportOptions().wrappers), PRODUCTION_AI_SDK_FILE_PATTERN],
          use: [{ loader: BRIDGE_IMPORT_LOADER, options: bridgeImportOptions() }],
        },
      ]);
    } finally {
      if (prevAiMode === undefined) delete process.env.PYRIC_AI_MODE;
      else process.env.PYRIC_AI_MODE = prevAiMode;
    }

    // Non-hoisted pnpm virtual-store layout where @firebase/component only sits beside @firebase/ai
    const pnpmStoreNm = path.join(monorepoRoot, 'node_modules', '.pnpm', '@firebase+ai@1.0.0', 'node_modules');
    const pnpmAiDir = path.join(pnpmStoreNm, '@firebase', 'ai', 'dist');
    const pnpmCompDir = path.join(pnpmStoreNm, '@firebase', 'component', 'dist');
    mkdirSync(pnpmAiDir, { recursive: true });
    mkdirSync(pnpmCompDir, { recursive: true });
    writeFileSync(
      path.join(pnpmStoreNm, '@firebase', 'ai', 'package.json'),
      JSON.stringify({ name: '@firebase/ai', version: '1.0.0', exports: { '.': './dist/index.mjs' } }),
    );
    writeFileSync(path.join(pnpmAiDir, 'index.mjs'), 'export const ai = 1;\n');
    writeFileSync(
      path.join(pnpmStoreNm, '@firebase', 'component', 'package.json'),
      JSON.stringify({ name: '@firebase/component', version: '1.0.0', exports: { '.': './dist/index.mjs' } }),
    );
    writeFileSync(path.join(pnpmCompDir, 'index.mjs'), 'export const _registerComponent = () => {};\n');

    const rewritten = bridgeImportLoader.call(
      {
        resourcePath: path.join(pnpmAiDir, 'index.mjs'),
        rootContext: monorepoRoot,
        getOptions: () => bridgeImportOptions(),
      },
      'import{_registerComponent}from"@firebase/component";\n',
    );
    expect(rewritten).not.toContain('"@firebase/component"');
  });

  it('3. enforces Vite #imports & plugin-alias client stops, non-production SSR routing, and real server.close() process-stop cleanup', async () => {
    const root = makeTempDir('pyric-canary-vite-');
    const emptyDir = makeTempDir('pyric-canary-vite-empty-');
    const badPyricDir = makeTempDir('pyric-canary-vite-badcfg-');
    writeFileSync(path.join(badPyricDir, 'pyric.json'), '{ malformed json\n');
    const firebaseDir = findInstalledPackageRoot('firebase/app', 'firebase');
    const scopedAppEntry = createRequire(path.join(firebaseDir, 'package.json')).resolve('@firebase/app');
    const scopedAppDir = path.resolve(path.dirname(scopedAppEntry), '..');
    const adminDir = findInstalledPackageRoot('firebase-admin/app', 'firebase-admin');
    mkdirSync(path.join(root, 'node_modules', '@firebase', 'firestore'), { recursive: true });
    symlinkSync(scopedAppDir, path.join(root, 'node_modules', '@firebase', 'app'), 'dir');
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

    const ssrBuilt = await viteBuild({
      root,
      mode: 'development',
      logLevel: 'silent',
      build: { ssr: ssrEntry, write: false },
      plugins: [pyricVite()],
    });
    let outputs: ReadonlyArray<object>;
    if (Array.isArray(ssrBuilt)) {
      outputs = ssrBuilt[0]!.output;
    } else {
      outputs = (ssrBuilt as { output: ReadonlyArray<object> }).output;
    }
    const bundledCode = outputs
      .map((chunk) => {
        const maybeCode = (chunk as { code?: unknown }).code;
        if (typeof maybeCode === 'string') return maybeCode;
        return '';
      })
      .join('\n');
    expect(bundledCode).not.toContain('SharedWorker');
    expect(bundledCode).not.toContain('__PYRIC_DEV_RUNTIME__');
    expect(bundledCode).toContain('@pyric/cli/vite/ssr-loader');

    // Run real Vite servers in a dedicated Node subprocess so real Module.registerHooks
    // lifecycle across pyric(), pyricLive(), failed startup, and server.close() is exercised end-to-end.
    const nodeProbe = [
      "import path from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "import { registerHooks } from 'node:module';",
      `const wsRoot = ${JSON.stringify(workspaceRoot)};`,
      'const bases = [',
      "  pathToFileURL(path.join(wsRoot, 'packages/cli/package.json')).href,",
      "  pathToFileURL(path.join(wsRoot, 'packages/pyric/package.json')).href,",
      "  pathToFileURL(path.join(wsRoot, 'packages/live/package.json')).href,",
      '];',
      'registerHooks({',
      '  resolve(specifier, context, nextResolve) {',
      '    try { return nextResolve(specifier, context); } catch {}',
      '    for (const parentURL of bases) {',
      '      try { return nextResolve(specifier, { ...context, parentURL }); } catch {}',
      '    }',
      '    return nextResolve(specifier, context);',
      '  },',
      '});',
      "const { createServer } = await import('vite');",
      "const { pyric } = await import('@pyric/cli/vite');",
      "const { pyricLive } = await import('@pyric/live/vite');",
      `const root = ${JSON.stringify(root)};`,
      `const emptyDir = ${JSON.stringify(emptyDir)};`,
      `const badPyricDir = ${JSON.stringify(badPyricDir)};`,
      `const importer = ${JSON.stringify(ssrEntry)};`,
      'const aliasPlugin = {',
      "  name: 'custom-sdk-alias',",
      '  resolveId(source) {',
      "    if (source === '@sdk/firestore') return path.join(root, 'node_modules/@firebase/firestore/index.js');",
      '    return null;',
      '  },',
      '};',
      'try { await createServer({ root: emptyDir, logLevel: "silent", plugins: [pyricLive()] }); } catch {}',
      'try { await createServer({ root: badPyricDir, logLevel: "silent", plugins: [pyric()] }); } catch {}',
      'let leakedBefore = null;',
      "try { await import('firebase-admin/app'); } catch (e) { leakedBefore = e?.code ?? 'err'; }",
      'const sandbox = await createServer({ root, logLevel: "silent", server: { host: "127.0.0.1", port: 0 }, plugins: [pyric(), aliasPlugin] });',
      "const hashStop = await sandbox.pluginContainer.resolveId('#direct-firestore', importer);",
      "const pluginAliasStop = await sandbox.pluginContainer.resolveId('@sdk/firestore', importer);",
      'let duringSandbox = null;',
      "try { await import('firebase-admin/auth'); } catch (e) { duringSandbox = e?.code ?? 'err'; }",
      'const live = await createServer({ root, logLevel: "silent", server: { host: "127.0.0.1", port: 0 }, plugins: [pyricLive({ project: "org-alpha" })] });',
      'let duringLive = null;',
      "try { await import('firebase-admin/firestore'); } catch (e) { duringLive = e?.code ?? 'err'; }",
      'await sandbox.close();',
      'await live.close();',
      'process.env.PYRIC_AI_MODE = "production";',
      'const prodAiServer = await createServer({ root, logLevel: "silent", server: { host: "127.0.0.1", port: 0 }, plugins: [pyric()] });',
      "const passthroughApp = await prodAiServer.pluginContainer.resolveId('firebase/app', importer);",
      "const passthroughCheck = await prodAiServer.pluginContainer.resolveId('firebase/app-check', importer);",
      "const realAppTarget = await prodAiServer.pluginContainer.resolveId('firebase/app', passthroughApp.id);",
      "const realCheckTarget = await prodAiServer.pluginContainer.resolveId('firebase/app-check', passthroughCheck.id);",
      "const scopedAppFromReal = await prodAiServer.pluginContainer.resolveId('@firebase/app', realAppTarget.id);",
      "const scopedCheckFromReal = await prodAiServer.pluginContainer.resolveId('@firebase/app-check', realCheckTarget.id);",
      "const directAppStop = await prodAiServer.pluginContainer.resolveId('@firebase/app', importer);",
      'await prodAiServer.close();',
      'delete process.env.PYRIC_AI_MODE;',
      'let afterClose = "ok";',
      "try { await import('firebase/app'); } catch (e) { afterClose = e?.code ?? 'err'; }",
      'console.log(JSON.stringify({',
      "  leakedBefore,",
      "  hashStopped: Boolean(hashStop?.id?.startsWith('\\0pyric-stop:')),",
      "  pluginAliasStopped: Boolean(pluginAliasStop?.id?.startsWith('\\0pyric-stop:')),",
      "  prodAiAppAllowed: Boolean(scopedAppFromReal?.id && !scopedAppFromReal.id.startsWith('\\0pyric-stop:')),",
      "  prodAiCheckAllowed: Boolean(scopedCheckFromReal?.id && !scopedCheckFromReal.id.startsWith('\\0pyric-stop:')),",
      "  prodAiDirectStopped: Boolean(directAppStop?.id?.startsWith('\\0pyric-stop:')),",
      '  duringSandbox,',
      '  duringLive,',
      '  afterClose,',
      '}));',
      'process.exit(0);',
    ].join('\n');

    const child = spawnSync(process.env.PYRIC_TEST_NODE ?? 'node', ['--input-type=module', '-e', nodeProbe], {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: undefined, PYRIC_SANDBOX: undefined },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(child.status, child.stderr).toBe(0);
    const report = JSON.parse(child.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
    expect(report).toEqual({
      leakedBefore: null,
      hashStopped: true,
      pluginAliasStopped: true,
      prodAiAppAllowed: true,
      prodAiCheckAllowed: true,
      prodAiDirectStopped: true,
      duringSandbox: 'PYRIC_REAL_SDK_STOPPED',
      duringLive: 'PYRIC_LIVE_REFUSED',
      afterClose: 'ok',
    });
  }, 30_000);

  it('4. canonicalizes register preloads (--import and -r/--require), preserves foreign registers, and propagates to custom-env Workers', () => {
    const userPreload = '/opt/hooks/telemetry-register-preload.mjs';
    expect(loadsRegister(`--import ${userPreload}`, registerDistUrl)).toBe(false);
    expect(loadsRegister(`--import ${registerDistPath}`, registerDistUrl)).toBe(true);
    expect(loadsRegister(`-r ${registerDistPath}`, registerDistUrl)).toBe(true);
    expect(loadsRegister('--require=@pyric/cli/register', registerDistUrl)).toBe(true);

    const canonicalOptions = withCanonicalRegisterNodeOptions(
      `--import ${userPreload} -r ${registerDistPath}`,
      registerDistUrl,
    );
    expect(canonicalOptions).toContain(`--import ${userPreload}`);
    expect(canonicalOptions).toContain(`--import ${registerDistUrl}`);

    // Cross-register isolation
    expect(withCanonicalRegisterNodeOptions('--import @pyric/live/register', registerDistUrl)).toBe(
      '--import @pyric/live/register',
    );

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
    const prevSandbox = process.env.PYRIC_SANDBOX;
    process.env.NODE_OPTIONS = `-r ${registerDistPath} --import ${userPreload}`;
    process.env.PYRIC_SANDBOX = 'local';
    try {
      installWorkerGuard(registerDistUrl, target);
      new target.Worker(new URL('file:///app/worker.mjs'), {
        env: { NODE_OPTIONS: `--import ${userPreload}` },
      });
    } finally {
      if (prevNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prevNodeOptions;
      if (prevSandbox === undefined) delete process.env.PYRIC_SANDBOX;
      else process.env.PYRIC_SANDBOX = prevSandbox;
    }
    const workerEnv = capturedOptions[0]?.env as Record<string, string> | undefined;
    expect(workerEnv?.NODE_OPTIONS).toContain(`--import ${userPreload}`);
    expect(workerEnv?.NODE_OPTIONS).toContain(`--import ${registerDistUrl}`);
  });

  it('5. preserves sandbox activation env against inline shell and env -u overrides and coexists with outer *register* preloads', async () => {
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
    const argv = [
      'env',
      '-vu',
      'PYRIC_SANDBOX',
      '-vu',
      'NODE_OPTIONS',
      'sh',
      '-c',
      `PYRIC_SANDBOX='' PYRIC_SESSION_TOKEN=forged CUSTOM_FLAG=kept node ${JSON.stringify(probeScript)}`,
    ];
    const handle = spawnSandboxChild({ argv, label: 'probe' }, { cwd: dir, env: childEnv, json: true });
    const exitCode = await handle.exited;
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(readFileSync(outFile, 'utf8')) as Record<string, unknown>;
    expect(parsed).toEqual({
      sandbox: 'remote:http://127.0.0.1:44100',
      token: 'expected-session-token',
      custom: 'kept',
      userHook: true,
      registerActive: true,
    });
  });

  it('6. refuses unsupported runtimes across POSIX command-prefix builtins, command substitutions, shell flags, and fail-closed dynamic constructs', () => {
    const blockedVectors: Array<[string[], 'bun' | 'deno']> = [
      [['sh', '-c', 'exec bun run dev'], 'bun'],
      [['sh', '-c', 'exec -a worker-proc bunx vite'], 'bun'],
      [['bash', '-lc', 'command deno run server.ts'], 'deno'],
      [['sh', '-c', 'command -p bun x next dev'], 'bun'],
      [['sh', '-c', 'eval "bun run start"'], 'bun'],
      [['sh', '-c', 'nohup nice -n 5 exec bun script.ts'], 'bun'],
      [['sh', '-c', '$(bun x)'], 'bun'],
      [['sh', '-c', 'echo `deno run server.ts`'], 'deno'],
      [['sh', '-c', 'echo $((bun x); true)'], 'bun'],
      [['sh', '-c', 'echo $(case x in x) bun x;; esac)'], 'bun'],
      [['sh', '-mc', 'bun x'], 'bun'],
      [['sh', '-oc', 'errexit', 'bun x'], 'bun'],
      [['sh', '-co', 'errexit', 'bun x'], 'bun'],
      [['bash', '-Oc', 'extglob', 'bun x'], 'bun'],
      [['bash', '-O', 'extglob', '-c', 'bun x'], 'bun'],
      [['env', '-a', 'worker-proc', 'bun', 'x'], 'bun'],
      [['env', '-vS', 'bun x'], 'bun'],
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
    expect(detectUnsupportedRuntime(['sh', '-c', 'eval "node server.js"'])).toBeNull();
    expect(detectUnsupportedRuntime(['sh', '-c', 'command -v bun && node server.js'])).toBeNull();
  });
});
