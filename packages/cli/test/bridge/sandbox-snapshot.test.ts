/**
 * `sandbox.snapshot` — the connected sandbox's own promote-and-reseed round
 * trip. Composes the surface exactly like a real bridge session (the forwarded
 * dispatcher over an in-process sandbox), seeds Firestore data and an Auth
 * user, calls `sandbox.snapshot`, and feeds the result straight into the same
 * `--seed` loader `pyric sandbox --seed` uses (`startServe`), asserting the
 * same documents and user come back and that no real password field is
 * present by default.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { getAdminFirestore } from 'pyric/firestore';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';
import { startServe, type ServeRuntime } from '../../src/cli/serve.js';
import { silentServeLogger } from '../../src/serve/server.js';

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-sandbox-snapshot-'));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><head></head><body>s</body></html>');
  return dir;
}

const stops: ServeRuntime[] = [];
afterAll(async () => {
  for (const r of stops) await r.handle.stop();
});

describe('sandbox.snapshot', () => {
  it('promotes live Firestore docs + Auth users into a fixture `--seed` reloads, with passwords redacted by default', async () => {
    const sandbox = initializeSandbox();

    // Seed the live sandbox directly (admin, bypassing rules — the sandbox's
    // own seeding posture), the same way an app or an agent would leave data
    // behind before promoting it.
    const { doc, setDoc } = await import('pyric/firestore');
    const db = getAdminFirestore(sandbox);
    await setDoc(doc(db, 'posts/a'), { title: 'x' });
    await setDoc(doc(db, 'posts/b'), { title: 'y' });
    authSandbox.seedUsers(getAuth(sandbox), [{ uid: 'u1', email: 'a@x.com', password: 'secret-pw' }]);

    const dispatch = buildSandboxDispatcher(sandbox);
    const result = await dispatch('sandbox', 'snapshot', {});
    expect(result.ok).toBe(true);
    const fixture = result.data as {
      version: number;
      firestore: { version: number; firestore: Record<string, unknown> };
      auth: { users: Array<{ uid: string; email: string; password: string }> };
    };

    // Shape matches `PyricStateFile` (state-store.ts): version key + firestore
    // + auth sections.
    expect(fixture.version).toBe(1);
    expect(Object.keys(fixture.firestore.firestore).sort()).toEqual(['posts/a', 'posts/b']);
    expect(fixture.auth.users).toHaveLength(1);

    // Passwords are redacted by default — no real secret leaves the tool.
    expect(fixture.auth.users[0]!.password).not.toBe('secret-pw');
    expect(fixture.auth.users[0]!.password).toBe('__pyric_no_password__');

    // Feed the tool's own output straight into the CLI's `--seed` loader —
    // byte-for-byte the same fixture shape `pyric snapshot` writes.
    const cwd = project();
    writeFileSync(join(cwd, 'fixture.json'), JSON.stringify(fixture));
    const r = await startServe({
      cwd,
      port: 0,
      cacheRoot: join(cwd, '.cache'),
      seed: 'fixture.json',
      logger: silentServeLogger(),
    });
    stops.push(r);
    const payload = r.payload();
    expect(payload.seed).toBeNull();
    expect(payload.seedState).toEqual(fixture.firestore);
    expect(payload.authUsers).toEqual(fixture.auth.users);
  }, 30_000);

  it('includePasswords:true keeps the real secret', async () => {
    const sandbox = initializeSandbox();
    authSandbox.seedUsers(getAuth(sandbox), [{ uid: 'u1', email: 'a@x.com', password: 'secret-pw' }]);

    const dispatch = buildSandboxDispatcher(sandbox);
    const result = await dispatch('sandbox', 'snapshot', { includePasswords: true });
    const fixture = result.data as { auth: { users: Array<{ password: string }> } };
    expect(fixture.auth.users[0]!.password).toBe('secret-pw');
  });
});
