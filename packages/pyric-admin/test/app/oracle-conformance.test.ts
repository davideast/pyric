/**
 * Oracle conformance (admin app registry) — wires the Phase-A
 * `scripts/oracle/observations/admin-app-*.json` captures of firebase-admin's
 * in-process app registry into the test suite so the CAPTURED real-firebase
 * behavior is machine-checked against pyric-admin's default-app registry, not
 * merely cited in comments.
 *
 * Philosophy (see packages/pyric/test/auth/oracle-conformance.test.ts): each
 * observation's recorded values are the EXPECTED side. We assert the
 * environment-independent facts the capture pinned — error CODES, error-class
 * NAMES, message shapes, app names, registry counts, idempotency identity — and
 * deliberately NOT prod-only noise (real service constructor names like
 * `Auth`/`Firestore`/`Storage`, the databaseURL requirement, credentials).
 *
 * Every `admin-app-*` observation must be either asserted here or listed in
 * NOT_APPLICABLE with a reason; the completeness test at the bottom enforces
 * that so a new capture can't silently go un-checked.
 *
 * The registry is a process-global singleton (mirroring firebase-admin's
 * AppStore), so each case resets it first via the test-only reset helper.
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
  __resetAppRegistryForTests,
  type PyricAdminApp,
} from '../../src/app/index.js';
import { getDatabase } from '../../src/database/index.js';
import { getAuth } from '../../src/auth/index.js';
import { getStorage } from '../../src/storage/index.js';
import { getFirestore } from '../../src/firestore/index.js';

const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'scripts', 'oracle', 'observations');

/** Observations that cannot be replayed against the pyric-admin sandbox, with
 *  the reason. */
const NOT_APPLICABLE: Record<string, string> = {
  'admin-app-getdatabase-missing-url.json':
    'prod-only: getDatabase() requires a configured databaseURL and throws database/invalid-argument without one. The pyric-admin sandbox has no notion of a databaseURL (getDatabase() resolves the default sandbox app directly), so this capture documents prod behavior only.',
};

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

async function expectRejectedCode(p: Promise<unknown>, code: string): Promise<Error> {
  try {
    await p;
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return e as Error;
  }
  throw new Error(`expected a rejection with code ${code}`);
}

beforeEach(async () => {
  await __resetAppRegistryForTests();
});
afterEach(async () => {
  await __resetAppRegistryForTests();
});

describe('oracle conformance (admin app registry)', () => {
  it('admin-app-initializeapp-noarg-default', () => {
    const obs = load('admin-app-initializeapp-noarg-default');
    expect(getApps().length).toBe(obs.getAppsBeforeInit as number); // 0
    const app = initializeApp({ sandbox: initializeSandbox() }); // implicit [DEFAULT]
    expect(app.name).toBe(obs.defaultAppName as string); // '[DEFAULT]'
    expect(getApps().length).toBe(obs.getAppsAfterInit as number); // 1
    // getApp() with no arg resolves the same default instance.
    expect(getApp() === app).toBe(obs.getAppNoArgResolvesDefault as boolean);
    expect(getApp().name).toBe(obs.getAppNoArgName as string); // '[DEFAULT]'
  });

  it('admin-app-initializeapp-named', () => {
    const obs = load('admin-app-initializeapp-named');
    initializeApp({ sandbox: initializeSandbox() }); // default
    const named = initializeApp({ sandbox: initializeSandbox() }, 'secondary');
    expect(named.name).toBe(obs.namedAppName as string); // 'secondary'
    expect(getApp('secondary').name).toBe(obs.getAppByNameName as string);
    expect(getApps().length).toBe(obs.getAppsCountWithDefaultAndNamed as number); // 2
  });

  it('admin-app-initializeapp-reinit-idempotent', async () => {
    const obs = load('admin-app-initializeapp-reinit-idempotent');
    // No-arg re-init: returns the SAME [DEFAULT] app, no throw (prod auto-init).
    const a = initializeApp();
    const b = initializeApp();
    expect(a === b).toBe(!(obs.reinitNoArgThrew as boolean)); // did not throw → same
    expect(a.name).toBe(obs.reinitNoArgName as string); // '[DEFAULT]'
    await deleteApp(a);
    // Same-options named re-init: idempotent (returns the same handle).
    const c = initializeApp({ databaseURL: 'https://a.firebaseio.com' }, 'app1');
    const d = initializeApp({ databaseURL: 'https://a.firebaseio.com' }, 'app1');
    expect(c === d).toBe(!(obs.reinitSameOptionsThrew as boolean));
    expect(c.name).toBe(obs.reinitSameOptionsName as string); // 'app1'
    await deleteApp(c);
  });

  it('admin-app-initializeapp-duplicate-different-config', async () => {
    const obs = load('admin-app-initializeapp-duplicate-different-config');
    const first = initializeApp({ databaseURL: 'https://a.firebaseio.com' }, 'app1');
    const err = expectThrewCode(
      () => initializeApp({ databaseURL: 'https://b.firebaseio.com' }, 'app1'),
      obs.code as string, // 'app/duplicate-app'
    );
    expect(err.constructor.name).toBe(obs.errorName as string); // 'FirebaseAppError'
    expect(err instanceof Error).toBe(obs.isError as boolean);
    expect(err.message).toBe(obs.message as string);
    await deleteApp(first);
  });

  it('admin-app-initializeapp-autoinit-mismatch', async () => {
    const obs = load('admin-app-initializeapp-autoinit-mismatch');
    const first = initializeApp({ databaseURL: 'https://a.firebaseio.com' }, 'app1');
    const err = expectThrewCode(
      () => initializeApp(undefined, 'app1'),
      obs.code as string, // 'app/invalid-app-options'
    );
    expect(err.constructor.name).toBe(obs.errorName as string);
    expect(err.message).toBe(obs.message as string);
    await deleteApp(first);
  });

  it('admin-app-initializeapp-invalid-name', () => {
    const obs = load('admin-app-initializeapp-invalid-name');
    const err = expectThrewCode(
      () => initializeApp({ sandbox: initializeSandbox() }, ''),
      obs.code as string, // 'app/invalid-app-name'
    );
    expect(err.constructor.name).toBe(obs.errorName as string);
    expect(err.message).toBe(obs.message as string); // '...name "" provided...'
  });

  it('admin-app-getapp-unknown-name', () => {
    const obs = load('admin-app-getapp-unknown-name');
    const err = expectThrewCode(() => getApp('does-not-exist'), obs.code as string); // 'app/no-app'
    expect(err.constructor.name).toBe(obs.errorName as string);
    expect(err.message).toBe(obs.message as string);
  });

  it('admin-app-no-app-error (every accessor, nothing initialized)', () => {
    const obs = load('admin-app-no-app-error');
    // getApp() itself.
    const errApp = expectThrewCode(() => getApp(), obs.code as string); // 'app/no-app'
    expect(errApp.constructor.name).toBe(obs.errorName as string);
    expect(errApp.message).toBe(obs.message as string);
    expect(errApp instanceof Error).toBe(obs.isError as boolean);
    // Each no-arg accessor bubbles the identical no-app error.
    for (const accessor of [
      () => getDatabase(),
      () => getAuth(),
      () => getStorage(),
      () => getFirestore(),
    ]) {
      const err = expectThrewCode(accessor, obs.code as string);
      expect(err.constructor.name).toBe(obs.errorName as string);
      expect(err.message).toBe(obs.message as string);
    }
    // The capture lists exactly the accessors we exercised.
    expect(obs.appliesTo).toEqual([
      'getDatabase',
      'getAuth',
      'getFirestore',
      'getStorage',
      'getApp',
    ]);
  });

  it('admin-app-accessors-resolve-default (no-arg resolves the default app)', () => {
    const obs = load('admin-app-accessors-resolve-default');
    initializeApp({ sandbox: initializeSandbox() });
    // No prod-noise (constructor names) — assert every accessor resolves the
    // default app and returns a usable handle without an explicit arg.
    expect(getAuth()).toBeDefined();
    expect(getDatabase()).toBeDefined();
    expect(getStorage()).toBeDefined();
    expect(getFirestore()).toBeDefined();
    expect(obs.allResolveDefaultNoArg).toBe(true);
  });

  it('admin-app-deleteapp', async () => {
    const obs = load('admin-app-deleteapp');
    const app = initializeApp({ sandbox: initializeSandbox() });
    expect(getApps().length).toBe(1);
    const ret = deleteApp(app);
    expect(ret && typeof ret.then === 'function').toBe(obs.deleteReturnsPromise as boolean);
    await ret;
    expect(getApps().length).toBe(obs.getAppsAfterDelete as number); // 0
    const err = expectThrewCode(() => getApp(), obs.getAppAfterDeleteCode as string);
    expect((err as { code?: string }).code).toBe(obs.getAppAfterDeleteCode as string);
    expect(obs.getAppAfterDeleteThrew).toBe(true);
    // Name can be re-initialized after deletion.
    let reThrew = false;
    try {
      initializeApp({ sandbox: initializeSandbox() });
    } catch {
      reThrew = true;
    }
    expect(reThrew).toBe(obs.reinitAfterDeleteThrew as boolean); // false
    // deleteApp(nonApp) → app/invalid-argument.
    const nonAppErr = await expectRejectedCode(
      deleteApp({} as unknown as PyricAdminApp),
      obs.deleteNonAppCode as string, // 'app/invalid-argument'
    );
    expect(nonAppErr.constructor.name).toBe(obs.deleteNonAppErrorName as string);
    expect(obs.deleteNonAppThrew).toBe(true);
  });

  // ── interaction: admin writes bypass RTDB security rules (incl. .validate) ──

  it('admin database write bypasses .validate (prod firebase-admin parity)', async () => {
    // prod firebase-admin bypasses ALL security rules — including RTDB
    // `.validate` — on admin writes. The pyric-admin sandbox database write
    // path (see packages/pyric-admin/src/database/index.ts) writes straight
    // into its in-memory tree with NO rules engine, so the sandbox's new
    // `.validate` walk cannot apply to admin writes. This asserts that an
    // admin write of data that would VIOLATE any sane `.validate` rule
    // (e.g. `newData.child('age').isNumber()`) SUCCEEDS and round-trips.
    initializeApp({ sandbox: initializeSandbox() });
    const db = getDatabase(); // default app
    const bad = { age: 'not-a-number', email: 12345, nested: { ok: false } };
    await db.ref('users/u1').set(bad); // must NOT throw a validation error
    const snap = await db.ref('users/u1').get();
    expect(snap.exists()).toBe(true);
    expect(snap.val()).toEqual(bad);
  });

  // ── completeness: every admin-app observation is asserted or explicitly N/A ─

  it('every admin-app observation is covered (no silent gaps)', () => {
    const all = readdirSync(OBS_DIR).filter(
      (f) => f.startsWith('admin-app-') && f.endsWith('.json'),
    );
    expect(all.length).toBeGreaterThanOrEqual(11);
    const source = readFileSync(import.meta.path, 'utf8');
    const uncovered = all.filter(
      (f) => !source.includes(f.replace('.json', '')) && !(f in NOT_APPLICABLE),
    );
    expect(uncovered).toEqual([]);
  });
});
