import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireViteLiveProcessStop,
  acquireViteProcessStop,
  installViteProcessStop,
  viteProcessStopHook,
  type SyncResolve,
} from '../../src/serve/vite-process-stop.js';
import { suppliedRows } from '../../src/serve/vite-supplied-rows.js';

const vitePluginEntry = fileURLToPath(new URL('../../src/serve/vite-plugin.ts', import.meta.url));

const require = createRequire(import.meta.url);
const realAdminApp = pathToFileURL(require.resolve('firebase-admin/app')).href;
const realFirebaseAi = pathToFileURL(require.resolve('firebase/ai')).href;
const appFile = pathToFileURL('/app/node_modules/local-admin-lib/index.js').href;
/** Where Node resolves `specifier` from the file at `url`. */
const resolvedFrom = (url: string, specifier: string): string =>
  pathToFileURL(createRequire(url).resolve(specifier)).href;
const realAiPackage = resolvedFrom(realFirebaseAi, '@firebase/ai');
const realAppPackage = resolvedFrom(realAiPackage, '@firebase/app');
const realComponentPackage = resolvedFrom(realAiPackage, '@firebase/component');
const realFirestorePackage = resolvedFrom(pathToFileURL(require.resolve('firebase/firestore')).href, '@firebase/firestore');
/** The file Vite's module runner imports an externalized dependency from (Vite 6 and later; any `vite` file names the package). */
const viteModuleRunner = new URL('./module-runner.js', import.meta.resolve('vite')).href;

/** A next resolve that lands on `url`, whatever was asked. */
const landsOn = (url: string): Parameters<SyncResolve>[2] => () => ({ url });

function stopOf(run: () => unknown): Error & { code?: string } {
  try {
    run();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('the resolve did not stop');
}

describe('the stop hook in the Vite dev server process (ADR 0022)', () => {
  it('stops a native load of the real firebase-admin, and reports it once', () => {
    const lines: string[] = [];
    const hook = viteProcessStopHook({ getAiMode: () => 'sandbox', write: (line) => lines.push(line) });
    const stop = () => hook('firebase-admin/app', { parentURL: appFile }, landsOn(realAdminApp));
    const error = stopOf(stop);
    expect(error.code).toBe('PYRIC_REAL_SDK_STOPPED');
    expect(error.message).toContain('stopped loading the real firebase-admin');
    expect(error.message).toContain("import 'firebase-admin/app'");
    expect(error.message).toContain(`from   ${appFile}`);
    expect(error.message).toContain(`found  ${realAdminApp}`);
    stopOf(stop);
    expect(lines).toEqual([`${error.message}\n`]);
  });

  it('lets every other resolve through unchanged', () => {
    const hook = viteProcessStopHook({ getAiMode: () => 'sandbox', write: () => undefined });
    const other = { url: pathToFileURL('/app/node_modules/react/index.js').href, format: 'commonjs' };
    expect(hook('react', { parentURL: appFile }, () => other)).toBe(other);
    expect(hook('node:fs', { parentURL: appFile }, landsOn('node:fs'))).toEqual({ url: 'node:fs' });
  });

  it('reads the AI mode on each resolve, so production AI mode loads the real firebase/ai', () => {
    let mode: 'sandbox' | 'production' = 'sandbox';
    const hook = viteProcessStopHook({ getAiMode: () => mode, write: () => undefined });
    const load = () => hook('firebase/ai', { parentURL: appFile }, landsOn(realFirebaseAi));
    expect(stopOf(load).code).toBe('PYRIC_REAL_SDK_STOPPED');
    mode = 'production';
    expect(load()).toEqual({ url: realFirebaseAi });
  });

  it('lets production AI mode load @firebase/ai from Vite\'s module runner, and what it imports', () => {
    // Vite inlines the real firebase/ai entry it passes through and imports
    // that entry's own `@firebase/ai` natively, by file URL from its runner.
    const hook = viteProcessStopHook({ getAiMode: () => 'production', write: () => undefined });
    const fromRunner = { parentURL: viteModuleRunner };
    expect(hook(realAiPackage, fromRunner, landsOn(realAiPackage))).toEqual({ url: realAiPackage });
    const fromAi = { parentURL: realAiPackage };
    expect(hook('@firebase/app', fromAi, landsOn(realAppPackage))).toEqual({ url: realAppPackage });
    expect(hook('@firebase/component', fromAi, landsOn(realComponentPackage))).toEqual({ url: realComponentPackage });
  });

  it('still stops the module runner\'s other real SDK loads', () => {
    const fromRunner = { parentURL: viteModuleRunner };
    const sandbox = viteProcessStopHook({ getAiMode: () => 'sandbox', write: () => undefined });
    expect(stopOf(() => sandbox(realAiPackage, fromRunner, landsOn(realAiPackage))).code).toBe('PYRIC_REAL_SDK_STOPPED');
    const production = viteProcessStopHook({ getAiMode: () => 'production', write: () => undefined });
    const firestore = () => production(realFirestorePackage, fromRunner, landsOn(realFirestorePackage));
    expect(stopOf(firestore).code).toBe('PYRIC_REAL_SDK_STOPPED');
    const app = () => production(realAppPackage, fromRunner, landsOn(realAppPackage));
    expect(stopOf(app).code).toBe('PYRIC_REAL_SDK_STOPPED');
    const fromApp = () => production('@firebase/ai', { parentURL: appFile }, landsOn(realAiPackage));
    expect(stopOf(fromApp).code).toBe('PYRIC_REAL_SDK_STOPPED');
  });
});

describe('installing the stop hook', () => {
  type Hooks = { resolve: SyncResolve };

  it('installs once per process, and a Vite restart only replaces the AI mode it reads', () => {
    const installed: Hooks[] = [];
    const slot: Record<symbol, unknown> = {};
    const registerHooks = (hooks: Hooks) => void installed.push(hooks);
    const first = installViteProcessStop({ slot, registerHooks, registerActive: () => false, getAiMode: () => 'sandbox' });
    const second = installViteProcessStop({ slot, registerHooks, registerActive: () => false, getAiMode: () => 'production' });
    expect([first, second]).toEqual([true, true]);
    expect(installed).toHaveLength(1);
    const resolve = installed[0]!.resolve;
    expect(resolve('firebase/ai', { parentURL: appFile }, landsOn(realFirebaseAi))).toEqual({ url: realFirebaseAi });
  });

  it('leaves the stop to the register when the register is active', () => {
    const installed: Hooks[] = [];
    const result = installViteProcessStop({
      slot: {},
      registerHooks: (hooks) => void installed.push(hooks),
      registerActive: () => true,
    });
    expect(result).toBe(false);
    expect(installed).toEqual([]);
  });

  it('throws PYRIC_UNSUPPORTED_NODE_VERSION on a Node without module.registerHooks', () => {
    const lines: string[] = [];
    const error = stopOf(() =>
      installViteProcessStop({
        slot: {},
        registerHooks: undefined,
        registerActive: () => false,
        nodeVersion: '22.14.0',
        write: (line) => lines.push(line),
      }),
    );
    expect(error.code).toBe('PYRIC_UNSUPPORTED_NODE_VERSION');
    expect(error.message).toContain('22.14.0');
    expect(error.message).toContain('>= 22.15');
    expect(lines).toEqual([`${error.message}\n`]);
  });

  it('stops standalone pyric() Vite dev server startup under Bun with PYRIC_UNSUPPORTED_RUNTIME', () => {
    const script = `
      import { pyric } from ${JSON.stringify(vitePluginEntry)};
      const plugin = pyric();
      const configHook = typeof plugin.config === 'function' ? plugin.config : plugin.config.handler;
      try {
        configHook({}, { command: 'serve', mode: 'development' });
        console.log('ALLOWED');
        process.exit(0);
      } catch (err) {
        console.log('CODE:' + err.code);
        process.exit(2);
      }
    `;
    const result = spawnSync('bun', ['-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('CODE:PYRIC_UNSUPPORTED_RUNTIME');
    expect(result.stderr).toContain('PYRIC_UNSUPPORTED_RUNTIME');
    expect(result.stderr).toContain('Bun');
    expect(result.stderr).toContain('module.registerHooks');
  });

  it('switches cleanly from pyric() to pyricLive() and releases completely on close', () => {
    const installed: Hooks[] = [];
    const slot: Record<symbol, unknown> = {};
    const registerHooks = (hooks: Hooks) => void installed.push(hooks);
    const releaseSandbox = acquireViteProcessStop({
      slot,
      registerHooks,
      registerActive: () => false,
      getAiMode: () => 'sandbox',
      write: () => undefined,
    });
    expect(installed).toHaveLength(1);
    const resolve = installed[0]!.resolve;
    expect(stopOf(() => resolve('firebase-admin/app', { parentURL: appFile }, landsOn(realAdminApp))).code)
      .toBe('PYRIC_REAL_SDK_STOPPED');

    const supplied = suppliedRows((specifier, plane) =>
      Object.assign(new Error(`live refused ${specifier} on ${plane}`), { code: 'PYRIC_LIVE_REFUSED' }),
    );
    const releaseLive = acquireViteLiveProcessStop(supplied, {
      slot,
      registerHooks,
      registerActive: () => false,
      write: () => undefined,
    });
    expect(installed).toHaveLength(1);
    // Even if the replacement server acquires before the old server closes, the top lease governs.
    expect(stopOf(() => resolve('firebase-admin/app', { parentURL: appFile }, landsOn(realAdminApp))).code)
      .toBe('PYRIC_LIVE_REFUSED');

    releaseSandbox();
    expect(stopOf(() => resolve('firebase-admin/app', { parentURL: appFile }, landsOn(realAdminApp))).code)
      .toBe('PYRIC_LIVE_REFUSED');

    releaseLive();
    expect(resolve('firebase-admin/app', { parentURL: appFile }, landsOn(realAdminApp))).toEqual({
      url: realAdminApp,
    });
  });
});
