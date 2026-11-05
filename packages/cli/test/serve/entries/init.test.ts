import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('init entry dependency boundary', () => {
  it('uses the active-auth coordinator instead of importing firebase/auth', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../../src/serve/entries/init.ts'),
      'utf8',
    );

    expect(source).toContain("from './active-auth.js'");
    expect(source).not.toContain("from './auth.js'");
  });

  it('does not import from runtime.js to keep Service Worker module graphs free of top-level await', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../../src/serve/entries/init.ts'),
      'utf8',
    );

    expect(source).not.toContain("from './runtime.js'");
  });
});

const INIT_ENTRY = join(import.meta.dir, '../../../src/serve/entries/init.ts');

/** Every module `init.ts` imports, except its payload, answers with an inert stand-in. */
const STANDIN = `
const noop = () => {};
export const getAuth = () => ({});
export const sandbox = { setAuthFlowResolver: noop };
export const listUsers = async () => [];
export const setLens = noop;
export const switchAllAuthUsers = async () => {};
export const signOutAllAuths = async () => {};
export const commitCredentialToAllAuths = async () => {};
export const getActiveAuthUser = () => null;
export const subscribeToActiveAuth = () => noop;
export const registerActiveAuth = noop;
export const installAvatarUpgrades = (enabled) => { globalThis.__avatarUpgrades = enabled; };
export const useWorker = false;
export const workerDb = null;
export class ServeAuthHelper { resolver() { return noop; } }
export const helperCustomClaims = () => undefined;
export const installServeAuthResolver = noop;
export const mountAuthHelperDialog = noop;
export const configureListenerAttribution = noop;
export const installPyricRuntimeChip = noop;
export const sandboxEventSource = () => ({});
export const getPyricRuntimeStatus = () => ({});
export const projectRuntimeIdentity = (user) => user;
`;

/** Bundles `init.ts` with `initPayload` from `payloadSource` and its other imports stood in. */
async function bundleInit(payloadSource: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [INIT_ENTRY],
    format: 'iife',
    target: 'browser',
    plugins: [{
      name: 'init-standins',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          const isInitImport = args.importer === INIT_ENTRY;
          if (!isInitImport) return undefined;
          return { path: args.path, namespace: 'standin' };
        });
        build.onLoad({ filter: /.*/, namespace: 'standin' }, (args) => {
          const isPayload = args.path === './init-payload.js';
          return { contents: isPayload ? payloadSource : STANDIN, loader: 'js' };
        });
      },
    }],
  });
  return result.outputs[0]!.text();
}

/** Runs the bundled entry as a page would, with `document`, `window` and `console` supplied. */
function runInPage(code: string, pageConsole: Console): void {
  new Function('document', 'window', 'console', code)({}, {}, pageConsole);
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('init entry payload refusal (#2052)', () => {
  it('logs a refused init payload once and leaves no unhandled rejection', async () => {
    const code = await bundleInit(`export const initPayload = Promise.reject(
      new Error('Hosted sandbox initialization failed: This Node host serves project data only to clients on its own machine.'),
    );`);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    const logged: unknown[][] = [];
    const record = (...args: unknown[]): void => { logged.push(args); };
    const pageConsole = { ...console, error: record, warn: record };
    process.on('unhandledRejection', onUnhandled);
    try {
      runInPage(code, pageConsole);
      await settle();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.join(' ')).toContain('own machine');
  });

  it('installs avatar upgrades from an available payload', async () => {
    const code = await bundleInit('export const initPayload = Promise.resolve({ avatarUpgrades: true });');
    const realm = globalThis as { __avatarUpgrades?: boolean };
    delete realm.__avatarUpgrades;
    runInPage(code, console);
    await settle();
    expect(realm.__avatarUpgrades).toBe(true);
    delete realm.__avatarUpgrades;
  });
});
