/**
 * Oracle conformance (client app registry) — wires the `app-registry-*` captures
 * of the installed `firebase/app` package (packages/conformance/observations/app/)
 * into the test suite so the CAPTURED real-firebase behavior is machine-checked
 * against pyric/app's default-app registry, not merely cited in comments.
 *
 * Philosophy (see packages/pyric/test/auth/oracle-conformance.test.ts and the
 * admin twin packages/pyric-admin/test/app/oracle-conformance.test.ts): each
 * observation's recorded values are the EXPECTED side. We assert the
 * environment-independent facts the capture pinned — error CODES, error-class
 * NAMES, message text, app names, registry counts, idempotency identity — and
 * deliberately NOT prod-only handle shape (a sandbox app handle is opaque; it
 * does not carry firebase's `options` / `automaticDataCollectionEnabled`, which
 * the default/named captures also record but pyric does not claim).
 *
 * Every `app-registry-*` observation must be either asserted here or listed in
 * NOT_APPLICABLE with a reason; the completeness test at the bottom enforces
 * that so a new capture can't silently go un-checked.
 *
 * The registry is a process-global singleton (mirroring firebase/app's store),
 * so each case resets it first via getApps()/deleteApp().
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import {
  initializeApp,
  getApp,
  getApps,
  deleteApp,
  onLog,
  setLogLevel,
  registerVersion,
  SDK_VERSION,
  FirebaseError,
} from '../../src/app/index.js';

// app-registry-* observations live under the 'app' surface subdirectory.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'app');

/** Observations that cannot be replayed against the pyric/app sandbox registry. */
const NOT_APPLICABLE: Record<string, string> = {};

function load(name: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return json.behavior;
}

/** Run `fn`, assert it threw with the given `.code`, and return the error so
 *  callers can additionally assert class name / message. */
function expectThrewCode(fn: () => unknown, code: string): Error {
  try {
    fn();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return e as Error;
  }
  throw new Error(`expected a throw with code ${code}`);
}

async function expectRejectedOrThrewCode(p: () => Promise<unknown>, code: string): Promise<Error> {
  try {
    await p();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return e as Error;
  }
  throw new Error(`expected a rejection/throw with code ${code}`);
}

beforeEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});
afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('oracle conformance (client app registry)', () => {
  it('app-registry-initializeapp-default', () => {
    const obs = load('app-registry-initializeapp-default');
    const app = initializeApp({ sandbox: initializeSandbox() }); // implicit [DEFAULT]
    expect(app.name).toBe(obs.name as string); // '[DEFAULT]'
    expect(getApps().length).toBe(obs.getAppsLength as number); // 1
    expect(getApp() === app).toBe(obs.getAppNoArgResolvesSame as boolean); // true
    // (automaticDataCollectionEnabled / optionKeys are prod-only handle shape —
    //  the opaque sandbox handle does not claim them.)
  });

  it('app-registry-initializeapp-named', () => {
    const obs = load('app-registry-initializeapp-named');
    const def = initializeApp({ sandbox: initializeSandbox() });
    const named = initializeApp({ sandbox: initializeSandbox() }, 'secondary');
    expect(def.name).toBe(obs.defaultName as string); // '[DEFAULT]'
    expect(named.name).toBe(obs.namedName as string); // 'secondary'
    expect(getApps().length).toBe(obs.getAppsLength as number); // 2
    expect(getApp('secondary') === named).toBe(obs.getAppByNameResolvesSame as boolean);
  });

  it('app-registry-initializeapp-duplicate-name', () => {
    const obs = load('app-registry-initializeapp-duplicate-name');
    initializeApp({ sandbox: initializeSandbox() }); // default
    // A different sandbox under the same (default) name → different config.
    const err = expectThrewCode(
      () => initializeApp({ sandbox: initializeSandbox() }),
      obs.code as string, // 'app/duplicate-app'
    );
    expect(err.constructor.name).toBe(obs.errorName as string); // 'FirebaseError'
    expect(err instanceof Error).toBe(obs.isError as boolean);
    expect(err.message).toBe(obs.message as string);
  });

  it('app-registry-initializeapp-duplicate-config', () => {
    const obs = load('app-registry-initializeapp-duplicate-config');
    // EQUAL config for a sandbox app is the SAME sandbox reference (the deep-
    // equal-options idempotency analog).
    const sandbox = initializeSandbox();
    const first = initializeApp({ sandbox });
    const second = initializeApp({ sandbox });
    expect(first === second).toBe(obs.returnedSameInstance as boolean); // true
    expect(getApps().length).toBe(obs.getAppsLength as number); // 1
  });

  it('app-registry-getapp-default', () => {
    const obs = load('app-registry-getapp-default');
    const app = initializeApp({ sandbox: initializeSandbox() });
    const got = getApp();
    expect(got === app).toBe(obs.resolvesSameInstance as boolean);
    expect(got.name).toBe(obs.name as string); // '[DEFAULT]'
  });

  it('app-registry-getapp-named', () => {
    const obs = load('app-registry-getapp-named');
    initializeApp({ sandbox: initializeSandbox() });
    const named = initializeApp({ sandbox: initializeSandbox() }, 'secondary');
    const got = getApp('secondary');
    expect(got === named).toBe(obs.resolvesSameInstance as boolean);
    expect(got.name).toBe(obs.name as string); // 'secondary'
  });

  it('app-registry-getapp-unknown-name', () => {
    const obs = load('app-registry-getapp-unknown-name');
    const err = expectThrewCode(() => getApp('does-not-exist'), obs.code as string); // 'app/no-app'
    expect(err.constructor.name).toBe(obs.errorName as string); // 'FirebaseError'
    expect(err instanceof Error).toBe(obs.isError as boolean);
    expect(err.message).toBe(obs.message as string);
  });

  it('app-registry-getapps-contents', () => {
    const obs = load('app-registry-getapps-contents');
    const def = initializeApp({ sandbox: initializeSandbox() });
    const named = initializeApp({ sandbox: initializeSandbox() }, 'secondary');
    const apps = getApps();
    expect(Array.isArray(apps)).toBe(obs.isArray as boolean);
    expect(apps.length).toBe(obs.length as number); // 2
    expect(apps.includes(def)).toBe(obs.includesDefault as boolean);
    expect(apps.includes(named)).toBe(obs.includesNamed as boolean);
  });

  it('app-registry-deleteapp', async () => {
    const obs = load('app-registry-deleteapp');
    const named = initializeApp({ sandbox: initializeSandbox() }, 'secondary');
    const ret = deleteApp(named);
    expect(Boolean(ret && typeof ret.then === 'function')).toBe(obs.deleteReturnsPromise as boolean);
    await ret;
    expect(getApps().filter((a) => a.name === 'secondary').length).toBe(obs.getAppsAfterDelete as number); // 0
    const err = expectThrewCode(() => getApp('secondary'), obs.getAppAfterDeleteCode as string); // 'app/no-app'
    expect((err as { code?: string }).code).toBe(obs.getAppAfterDeleteCode as string);
    expect(obs.getAppAfterDeleteThrew).toBe(true);
    // The name can be re-initialized after deletion (the slot is free).
    let reinitThrew = false;
    try {
      initializeApp({ sandbox: initializeSandbox() }, 'secondary');
    } catch {
      reinitThrew = true;
    }
    expect(reinitThrew).toBe(obs.reinitAfterDeleteThrew as boolean); // false
  });

  it('app-registry-deleteapp-double', async () => {
    const obs = load('app-registry-deleteapp-double');
    const named = initializeApp({ sandbox: initializeSandbox() }, 'secondary');
    await deleteApp(named);
    const err = await expectRejectedOrThrewCode(() => Promise.resolve(deleteApp(named)), obs.code as string); // 'app/app-deleted'
    expect(err.constructor.name).toBe(obs.errorName as string); // 'FirebaseError'
    expect(err instanceof Error).toBe(obs.isError as boolean);
    expect(err.message).toBe(obs.message as string);
  });

  it('app-registry-sdk-version', () => {
    const obs = load('app-registry-sdk-version');
    // pyric re-exports firebase/app's SDK_VERSION — it IS the version the rig
    // captured against, so type, semver shape, AND value all match.
    expect(typeof SDK_VERSION).toBe(obs.type as string); // 'string'
    expect(/^\d+\.\d+\.\d+/.test(SDK_VERSION)).toBe(obs.isSemver as boolean);
    expect(SDK_VERSION).toBe(obs.value as string);
  });

  it('app-registry-firebaseerror-shape', () => {
    const obs = load('app-registry-firebaseerror-shape');
    const e = new FirebaseError('app/probe-code', 'probe message');
    expect(e.name).toBe(obs.errorName as string);
    expect(e.constructor.name).toBe(obs.ctorName as string);
    expect(e.code).toBe(obs.code as string);
    expect(e.message).toBe(obs.message as string);
    expect(e instanceof Error).toBe(obs.isError as boolean);
    expect(e instanceof FirebaseError).toBe(obs.isFirebaseError as boolean);
  });

  it('app-registry-onlog-setloglevel', () => {
    const obs = load('app-registry-onlog-setloglevel');
    const captured: Array<{ level: unknown; type: unknown; messageIsString: boolean; argsIsArray: boolean }> = [];
    let onLogReturn: unknown;
    try {
      onLogReturn = onLog((entry) => {
        captured.push({
          level: entry.level,
          type: entry.type,
          messageIsString: typeof entry.message === 'string',
          argsIsArray: Array.isArray(entry.args),
        });
      });
      setLogLevel('warn');
      registerVersion('pyric probe lib!!', 'not a version??');
    } finally {
      onLog(null);
      setLogLevel('info');
    }
    expect(onLogReturn === undefined ? 'undefined' : typeof onLogReturn).toBe(obs.onLogReturn as string);
    expect(captured.length).toBe(obs.emittedCount as number); // 1
    expect(captured[0]?.level).toBe(obs.emittedLevel as string); // 'warn'
    expect(captured[0]?.type).toBe(obs.emittedType as string); // '@firebase/app'
    expect(captured[0]?.messageIsString).toBe(obs.emittedMessageIsString as boolean);
    expect(captured[0]?.argsIsArray).toBe(obs.emittedArgsIsArray as boolean);
  });

  it('app-registry-registerversion', () => {
    const obs = load('app-registry-registerversion');
    let threw = false;
    let returnedUndefined = false;
    try {
      const ret = registerVersion('pyric-probe-lib', '1.2.3');
      returnedUndefined = ret === undefined;
    } catch {
      threw = true;
    }
    expect(threw).toBe(obs.threw as boolean); // false
    expect(returnedUndefined).toBe(obs.returnedUndefined as boolean); // true
  });

  // ── completeness: every app-registry observation is asserted or explicitly N/A ─

  it('every app-registry observation is covered (no silent gaps)', () => {
    const all = readdirSync(OBS_DIR).filter((f) => f.startsWith('app-registry-') && f.endsWith('.json'));
    expect(all.length).toBeGreaterThanOrEqual(14);
    const source = readFileSync(import.meta.path, 'utf8');
    const uncovered = all.filter((f) => !source.includes(f.replace('.json', '')) && !(f in NOT_APPLICABLE));
    expect(uncovered).toEqual([]);
  });
});
