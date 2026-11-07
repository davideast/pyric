/**
 * The Admin App Check row over the real `firebase-admin/app-check`: a gated
 * row. `verifyToken` and `createToken` pass the project gate, so an app on
 * another project is refused before any request, and an app on the live
 * project reaches the real method. The row makes no record: its calls don't
 * show in traffic yet, and the start line and health say so.
 *
 * Run it with the network off:
 * `unshare -rn sh -c 'ip link set lo up && bun test packages/live/test/admin-app-check-row.test.ts'`.
 */
import { beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { adminProjectGate } from '../src/admin/project-gate.js';
import { observeAdminAppCheck } from '../src/admin/app-check.js';

const PROJECT = 'demo-admin-app-check';

type AnyFunction = (...args: unknown[]) => unknown;
type AppCheck = Record<string, AnyFunction>;

const fromHere = createRequire(import.meta.url);
const appCheckModule = createRequire(fromHere.resolve('firebase-admin/app-check'))('./app-check') as { AppCheck: { prototype: Record<string, AnyFunction> } };
const realVerify = appCheckModule.AppCheck.prototype.verifyToken!;
const { initializeApp } = fromHere('firebase-admin/app') as { initializeApp(options: object, name: string): object };
const { getAppCheck } = fromHere('firebase-admin/app-check') as { getAppCheck(app: object): AppCheck };

const lines: string[] = [];
/** Where a call went: firebase-admin's own error code, or the gate's refusal. */
function codeOf(call: () => unknown): Promise<unknown> {
  try {
    return (call() as Promise<unknown>).then(() => 'ok', (error: { code?: unknown }) => error.code);
  } catch (error) {
    return Promise.resolve((error as { code?: unknown }).code);
  }
}

beforeAll(() => {
  observeAdminAppCheck(appCheckModule, { gate: adminProjectGate(PROJECT, (line) => lines.push(line), {}) });
});

test('the patched method keeps its name and length, and patching twice changes nothing', () => {
  const patched = appCheckModule.AppCheck.prototype.verifyToken!;
  expect(patched).not.toBe(realVerify);
  expect(patched.name).toBe(realVerify.name);
  expect(patched.length).toBe(realVerify.length);
  observeAdminAppCheck(appCheckModule, { gate: adminProjectGate(PROJECT, () => undefined, {}) });
  expect(appCheckModule.AppCheck.prototype.verifyToken).toBe(patched);
});

test('an app on another project is refused at verifyToken and createToken before any request', async () => {
  const other = getAppCheck(initializeApp({ projectId: 'other-project' }, 'admin-app-check-other'));
  expect(await codeOf(() => other.verifyToken!('not-a-token'))).toBe('PYRIC_LIVE_REFUSED');
  expect(await codeOf(() => other.createToken!('1:123:web:abc'))).toBe('PYRIC_LIVE_REFUSED');
  expect(lines).toHaveLength(1);
});

test('an AppCheck whose app the row cannot read is refused', async () => {
  // Stands in for a firebase-admin whose AppCheck no longer keeps its app as app.
  const unread = Object.create(appCheckModule.AppCheck.prototype) as AppCheck;
  expect(await codeOf(() => unread.verifyToken!('not-a-token'))).toBe('PYRIC_LIVE_REFUSED');
  expect(await codeOf(() => unread.createToken!('1:123:web:abc'))).toBe('PYRIC_LIVE_REFUSED');
});

test('an app on the live project reaches the real method, which answers with its own code', async () => {
  const own = getAppCheck(initializeApp({ projectId: PROJECT }, 'admin-app-check-own'));
  // The real verifyToken refuses a malformed token itself, before any request.
  expect(await codeOf(() => own.verifyToken!('not-a-token'))).toBe('app-check/invalid-argument');
});
