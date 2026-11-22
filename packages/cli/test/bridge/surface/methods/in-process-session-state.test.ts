import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';

import {
  loadProjectRules,
  loadSandboxSnapshot,
  saveSandboxSnapshot,
} from '../../../../src/bridge/server/in-process.js';
import { createSurfaceContext, renderSurface } from '../../../../src/bridge/surface/index.js';
import {
  captureAgentIdentity,
  captureAppSession,
  restoreAppSession,
  syncHydratedAgentIdentity,
} from '../../../../src/bridge/surface/methods/in-process-session-state.js';
import { parseArgs } from '../../../../src/cli/parse-args.js';
import { runSurfaceMethod } from '../../../../src/cli/surface-method-runner.js';

const PACKAGE_ROOT = resolve(import.meta.dir, '../../../..');
const DIST_CLI = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

async function runCliInMemory(cwd: string, key: string, argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runSurfaceMethod(key, parseArgs(argv), {
    cwd,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    discover: async () => null,
  });
  return { code, stdout, stderr };
}

describe('in-process-session-state (#1918)', () => {
  it('captures and restores the signed-in app session and tenant scope', () => {
    const first = initializeSandbox();
    const firstAuth = getAuth(first);
    authSandbox.seedUsers(firstAuth, [
      { uid: 'alice', email: 'alice@example.com', password: 'secret', tenantId: 'tenant-a' },
    ]);
    authSandbox.restoreSession(firstAuth, 'alice');
    authSandbox.setTenantId(firstAuth, 'tenant-a');

    const captured = captureAppSession(first);
    expect(captured).toEqual({ uid: 'alice', tenantId: 'tenant-a' });

    const second = initializeSandbox();
    const secondAuth = getAuth(second);
    authSandbox.seedUsers(secondAuth, [
      { uid: 'alice', email: 'alice@example.com', password: 'secret', tenantId: 'tenant-a' },
    ]);
    restoreAppSession(second, captured);
    expect(secondAuth.currentUser?.uid).toBe('alice');
    expect(authSandbox.getTenantId(secondAuth)).toBe('tenant-a');
  });

  it('leaves a sandbox signed out when the captured uid is absent', () => {
    const sandbox = initializeSandbox();
    getAuth(sandbox);
    restoreAppSession(sandbox, { uid: 'deleted-user', tenantId: null });
    expect(getAuth(sandbox).currentUser).toBeNull();
  });

  it('persists held agent identity across CLI invocations and enforces rules in later commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-cli-identity-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'firestore.rules'),
        `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`,
        'utf8',
      );

      expect(
        (
          await runCliInMemory(dir, 'auth.impersonate', [
            'impersonate',
            '--uid',
            'alice',
            '--json',
          ])
        ).code,
      ).toBe(0);

      const whoami = await runCliInMemory(dir, 'auth.whoami', ['whoami', '--json']);
      expect(whoami.code).toBe(0);
      expect(JSON.parse(whoami.stdout).data.agent).toMatchObject({ mode: 'uid', uid: 'alice' });

      const ownWrite = await runCliInMemory(dir, 'firestore.setDoc', [
        'setDoc',
        '--path',
        'users/alice',
        '--data',
        '{"name":"Alice"}',
        '--json',
      ]);
      expect(ownWrite.code).toBe(0);

      const otherWrite = await runCliInMemory(dir, 'firestore.setDoc', [
        'setDoc',
        '--path',
        'users/bob',
        '--data',
        '{"name":"Bob"}',
        '--json',
      ]);
      expect(otherWrite.code).toBe(2);

      expect(
        (await runCliInMemory(dir, 'auth.actAsAnonymous', ['actAsAnonymous', '--json'])).code,
      ).toBe(0);
      const anonWhoami = await runCliInMemory(dir, 'auth.whoami', ['whoami', '--json']);
      expect(JSON.parse(anonWhoami.stdout).data.agent).toEqual({ mode: 'anonymous' });

      expect((await runCliInMemory(dir, 'auth.actAsAdmin', ['actAsAdmin', '--json'])).code).toBe(0);
      const adminWhoami = await runCliInMemory(dir, 'auth.whoami', ['whoami', '--json']);
      expect(JSON.parse(adminWhoami.stdout).data.agent).toEqual({ mode: 'admin' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hydrates persisted agent identity on fallback after an earlier pre-fallback sync', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-cli-fallback-identity-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'firestore.rules'),
        `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`,
        'utf8',
      );

      expect(
        (await runCliInMemory(dir, 'auth.impersonate', ['impersonate', '--uid', 'alice'])).code,
      ).toBe(0);

      // Simulate runInProcessSession starting attached to a host (persisting === false):
      // syncHydratedAgentIdentity runs before loadSandboxSnapshot has ever run on `sandbox`.
      const sandbox = initializeSandbox();
      const ctx = createSurfaceContext(sandbox, dir);
      syncHydratedAgentIdentity(ctx);
      expect(ctx.identity.describe()).toEqual({ mode: 'default' });

      // Simulate activateOnFallback() loading `.pyric/state/in-process.json` later.
      loadSandboxSnapshot(sandbox, dir);
      loadProjectRules(sandbox, dir);

      const surface = renderSurface(undefined);
      const authTool = surface.tools.find((t) => t.name === 'auth');
      const firestoreTool = surface.tools.find((t) => t.name === 'firestore');
      if (authTool === undefined || firestoreTool === undefined) {
        throw new Error('missing surface tools');
      }

      const whoami = await authTool.execute({ method: 'whoami', args: {} }, ctx);
      expect(whoami.ok).toBe(true);
      expect((whoami.data as { agent: unknown }).agent).toMatchObject({ mode: 'uid', uid: 'alice' });

      const denied = await firestoreTool.execute(
        { method: 'setDoc', args: { path: 'users/bob', data: { name: 'Bob' } } },
        ctx,
      );
      expect(denied.ok).toBe(false);

      const allowed = await firestoreTool.execute(
        { method: 'setDoc', args: { path: 'users/alice', data: { name: 'Alice' } } },
        ctx,
      );
      expect(allowed.ok).toBe(true);

      saveSandboxSnapshot(sandbox, dir);
      expect(captureAgentIdentity(sandbox)).toMatchObject({ mode: 'uid', uid: 'alice' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'persists sandbox clock and AI Logic scripts across CLI invocations and real subprocesses',
    async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-cli-clock-ai-'));
    try {
      mkdirSync(dir, { recursive: true });
      const pinned = '2026-09-09T12:00:00.000Z';

      expect(
        (
          await runCliInMemory(dir, 'sandbox.setClock', [
            'setClock',
            '--isoTime',
            pinned,
            '--json',
          ])
        ).code,
      ).toBe(0);

      const inspect1 = await runCliInMemory(dir, 'sandbox.inspect', ['inspect', '--json']);
      expect(inspect1.code).toBe(0);
      expect(JSON.parse(inspect1.stdout).data.clock).toEqual({
        mode: 'fixed',
        now: Date.parse(pinned),
      });

      expect(
        (
          await runCliInMemory(dir, 'sandbox.advanceClock', [
            'advanceClock',
            '--ms',
            '5000',
            '--json',
          ])
        ).code,
      ).toBe(0);

      const inspect2 = await runCliInMemory(dir, 'sandbox.inspect', ['inspect', '--json']);
      expect(JSON.parse(inspect2.stdout).data.clock).toEqual({
        mode: 'fixed',
        now: Date.parse(pinned) + 5000,
      });

      expect(
        (
          await runCliInMemory(dir, 'ai_logic.script', [
            'script',
            '--match',
            '{"substring":"status"}',
            '--response',
            '{"type":"text","payload":"ready"}',
            '--json',
          ])
        ).code,
      ).toBe(0);

      const listed = await runCliInMemory(dir, 'ai_logic.scripts', ['scripts', '--json']);
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.stdout).data.scripts).toEqual([
        {
          match: { substring: 'status' },
          response: { type: 'text', payload: 'ready' },
          consumed: false,
        },
      ]);

      expect(
        (
          await runCliInMemory(dir, 'firestore.setDoc', [
            'setDoc',
            '--path',
            'items/one',
            '--data',
            '{"at":{"$serverTimestamp":true}}',
          ])
        ).code,
      ).toBe(0);
      const listedAfterUnrelatedWrite = await runCliInMemory(dir, 'ai_logic.scripts', [
        'scripts',
        '--json',
      ]);
      expect(JSON.parse(listedAfterUnrelatedWrite.stdout).data.scripts).toHaveLength(1);

      expect(
        (await runCliInMemory(dir, 'ai_logic.clearScripts', ['clearScripts', '--json'])).code,
      ).toBe(0);
      const listedAfterClear = await runCliInMemory(dir, 'ai_logic.scripts', ['scripts', '--json']);
      expect(JSON.parse(listedAfterClear.stdout).data.scripts).toEqual([]);

      expect((await runCliInMemory(dir, 'sandbox.resetClock', ['resetClock', '--json'])).code).toBe(
        0,
      );
      const inspectReset = await runCliInMemory(dir, 'sandbox.inspect', ['inspect', '--json']);
      expect(JSON.parse(inspectReset.stdout).data.clock.mode).toBe('wall');

      const procDir = join(dir, 'subprocess');
      mkdirSync(procDir, { recursive: true });
      const runSub = (args: string[]) =>
        spawnSync('node', [DIST_CLI, ...args, '--in-process', '--json'], {
          cwd: procDir,
          encoding: 'utf8',
          timeout: 30_000,
        });

      expect(runSub(['auth', 'impersonate', '--uid', 'carol']).status).toBe(0);
      const subWhoami = runSub(['auth', 'whoami']);
      expect(subWhoami.status).toBe(0);
      expect(JSON.parse(subWhoami.stdout).data.agent).toMatchObject({ mode: 'uid', uid: 'carol' });

      expect(runSub(['sandbox', 'setClock', '--isoTime', pinned]).status).toBe(0);
      const subInspect = runSub(['sandbox', 'inspect']);
      expect(subInspect.status).toBe(0);
      expect(JSON.parse(subInspect.stdout).data.clock).toEqual({
        mode: 'fixed',
        now: Date.parse(pinned),
      });

      expect(
        runSub([
          'ai_logic',
          'script',
          '--match',
          '{"substring":"hello"}',
          '--response',
          '{"type":"text","payload":"world"}',
        ]).status,
      ).toBe(0);
      const subScripts = runSub(['ai_logic', 'scripts']);
      expect(subScripts.status).toBe(0);
      expect(JSON.parse(subScripts.stdout).data.scripts).toEqual([
        {
          match: { substring: 'hello' },
          response: { type: 'text', payload: 'world' },
          consumed: false,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
  );
});
