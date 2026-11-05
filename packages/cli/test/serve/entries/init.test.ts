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

const ENTRIES = join(import.meta.dir, '../../../src/serve/entries');
const INIT_ENTRY = join(ENTRIES, 'init.ts');
const INIT_PAYLOAD = join(ENTRIES, 'init-payload.ts');

/**
 * What `init.ts` and `init-payload.ts` import, other than each other, answers
 * with an inert stand-in. `init-payload.ts` itself runs as served.
 */
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
export const recordDiagnostic = noop;
export const pageListenerObservation = noop;
export const initPayloadUrl = async () => '/__pyric/init.json';
export const nodeRuntimeOrigin = () => undefined;
`;

/**
 * A page that loads `init.ts`, then reads `initPayload` a second time the way
 * the page runtime's bridge connect does.
 */
const PAGE = `
import ${JSON.stringify(INIT_ENTRY)};
import { initPayload, logInitPayloadFailure } from ${JSON.stringify(INIT_PAYLOAD)};
initPayload.then(() => {}, logInitPayloadFailure);
`;

function isServedModule(path: string): boolean {
  return path === './init-payload.js' || path === INIT_ENTRY || path === INIT_PAYLOAD;
}

async function bundlePage(): Promise<string> {
  const result = await Bun.build({
    entrypoints: ['page-entry'],
    format: 'iife',
    target: 'browser',
    plugins: [{
      name: 'page-standins',
      setup(build) {
        build.onResolve({ filter: /^page-entry$/ }, () => ({ path: 'page-entry', namespace: 'page' }));
        build.onLoad({ filter: /.*/, namespace: 'page' }, () => ({ contents: PAGE, loader: 'js' }));
        build.onResolve({ filter: /.*/ }, (args) => {
          if (isServedModule(args.path)) return undefined;
          const isStoodIn = args.importer === INIT_ENTRY || args.importer === INIT_PAYLOAD;
          if (!isStoodIn) return undefined;
          return { path: args.path, namespace: 'standin' };
        });
        build.onLoad({ filter: /.*/, namespace: 'standin' }, () => ({ contents: STANDIN, loader: 'js' }));
      },
    }],
  });
  return result.outputs[0]!.text();
}

/** A page that declares the Node host, whose `init.json` answers with `payload`. */
function runPage(code: string, payload: object, pageConsole: Console): void {
  const hostMeta = { getAttribute: (name: string) => (name === 'content' ? 'node' : null) };
  const document = { querySelector: (selector: string) => (selector.includes('pyric-sandbox-host') ? hostMeta : null) };
  const fetch = async (): Promise<Response> => Response.json(payload);
  new Function('document', 'window', 'console', 'fetch', code)(document, {}, pageConsole, fetch);
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe('init entry payload refusal (#2052)', () => {
  it('logs a Node host refusal once and leaves no unhandled rejection', async () => {
    const code = await bundlePage();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    const logged: unknown[][] = [];
    const record = (...args: unknown[]): void => { logged.push(args); };
    const pageConsole = { ...console, error: record, warn: record };
    process.on('unhandledRejection', onUnhandled);
    try {
      runPage(code, { remotePeer: true }, pageConsole);
      await settle();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.join(' ')).toContain('Hosted sandbox initialization failed: This Node host serves project data only to clients on its own machine');
  });

  it('installs avatar upgrades from an available payload', async () => {
    const code = await bundlePage();
    const realm = globalThis as { __avatarUpgrades?: boolean };
    delete realm.__avatarUpgrades;
    runPage(code, { hosted: true, projectKey: null, avatarUpgrades: true }, console);
    await settle();
    expect(realm.__avatarUpgrades).toBe(true);
    delete realm.__avatarUpgrades;
  });
});
