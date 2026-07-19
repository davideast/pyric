import 'fake-indexeddb/auto';
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';
import {
  connectFunctionsWorkerPeer,
  createFunctionsWorkerHostCtx,
} from './worker-peer.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');

let command: ChildProcess | undefined;
let peer: { close(): Promise<void> } | undefined;
let observer: RemoteSandbox | undefined;

async function connectWorkerPeer(
  url: string,
  opts: { firestoreRules?: string } = {},
): Promise<{ close(): Promise<void> }> {
  const ctx = await createFunctionsWorkerHostCtx({
    persistenceKeyPrefix: 'functions-dev',
    instanceId: 'functions-dev-e2e',
    ...(opts.firestoreRules !== undefined ? { firestoreRules: opts.firestoreRules } : {}),
  });
  return connectFunctionsWorkerPeer({ url, ctx, sandboxId: 'functions-dev-peer' });
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(20);
  }
  throw new Error('timed out waiting for pyric dev Functions outcome');
}

afterAll(async () => {
  observer?.close();
  if (peer) await peer.close();
  if (command?.exitCode === null) command.kill('SIGKILL');
});

describe('pyric dev Functions RTDB integration', () => {
  test('executes unchanged CommonJS and ESM sources in one sandbox and stops cleanly', async () => {
    if (!existsSync(cliEntry)) throw new Error(`build the CLI first: ${cliEntry}`);
    for (const format of ['commonjs', 'module'] as const) {
      const esm = format === 'module';
      const cwd = mkdtempSync(join(tmpdir(), `pyric-functions-dev-${format}-`));
      const entry = esm ? 'index.js' : 'index.cjs';
      mkdirSync(join(cwd, 'public'));
      mkdirSync(join(cwd, 'functions/node_modules'), { recursive: true });
      writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>fixture</body>');
      writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({
        projects: { default: 'demo-project' },
      }));
      writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({
        hosting: { public: 'public' },
        functions: { source: 'functions' },
      }));
      writeFileSync(join(cwd, 'functions/package.json'), JSON.stringify({
        name: `unchanged-functions-${format}`,
        private: true,
        type: format,
        main: entry,
      }));
      writeFileSync(join(cwd, 'functions', entry), esm
        ? `import { onValueCreated } from 'firebase-functions/v2/database';
await Promise.resolve();
export const makeUppercase = onValueCreated(
  '/messages/{pushId}/original',
  event => event.data.ref.parent.child('uppercase')
    .set(event.data.val().toUpperCase()),
);
`
        : `const { onValueCreated } = require('firebase-functions/v2/database');
exports.makeUppercase = onValueCreated(
  '/messages/{pushId}/original',
  event => event.data.ref.parent.child('uppercase')
    .set(event.data.val().toUpperCase()),
);
`);
      symlinkSync(
        join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
        join(cwd, 'functions/node_modules/firebase-functions'),
      );

      let stdout = '';
      let stderr = '';
      command = spawn('node', [
        cliEntry,
        'dev',
        '--port=0',
        '--host=127.0.0.1',
        '--no-open',
        '--no-capture',
      ], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      command.stdout?.setEncoding('utf8');
      command.stderr?.setEncoding('utf8');
      command.stdout?.on('data', (chunk: string) => { stdout += chunk; });
      command.stderr?.on('data', (chunk: string) => { stderr += chunk; });

      try {
        const pointer = await waitFor(() => {
          const path = join(cwd, '.pyric/serve.json');
          return existsSync(path)
            ? JSON.parse(readFileSync(path, 'utf8')) as { url: string }
            : null;
        });
        peer = await connectWorkerPeer(
          `${pointer.url.replace(/^http/, 'ws')}/__pyric/sandbox`,
        );
        observer = await connectRemoteSandbox({ url: pointer.url });
        await waitFor(() =>
          stdout.includes('✔ functions 1 onValueCreated trigger') ? true : null);

        await observer.rtdb.set('messages/id/original', 'hello');
        await waitFor(async () =>
          (await observer!.rtdb.get('messages/id/uppercase')) === 'HELLO' ? true : null);
        await waitFor(() =>
          stdout.includes('✔ function  makeUppercase ← /messages/id/original') ? true : null);

        command.kill('SIGTERM');
        const code = await Promise.race([
          new Promise<number>((resolveExit) =>
            command!.once('exit', (exit) => resolveExit(exit ?? 1))),
          Bun.sleep(5_000).then(() => -1),
        ]);
        expect(code).toBe(0);
        expect(stdout).toContain('Shutting down...');
        expect(stderr).not.toContain('Functions child exited unexpectedly');
      } finally {
        observer?.close();
        observer = undefined;
        await peer?.close().catch(() => {});
        peer = undefined;
        if (command?.exitCode === null) command.kill('SIGKILL');
        command = undefined;
      }
    }
  }, 30_000);

  test('an onValueCreated trigger stamps a Firestore doc via firebase-admin (admin bypasses deny rules; client-lens denied) (#394)', async () => {
    if (!existsSync(cliEntry)) throw new Error(`build the CLI first: ${cliEntry}`);
    // The pychat presence→users stamp shape: an RTDB write triggers a Cloud
    // Function that writes a Firestore doc through firebase-admin/firestore.
    // The ruleset DENIES a signed-out (client/anon) caller on `users/*` — only
    // the row's own owner may write. firebase-admin bypasses rules, so the
    // function's admin write must LAND; a client-lens (anon) write to the same
    // path must be DENIED.
    const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-functions-dev-firestore-'));
    mkdirSync(join(cwd, 'public'));
    mkdirSync(join(cwd, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>fixture</body>');
    writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-project' } }));
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({
      hosting: { public: 'public' },
      functions: { source: 'functions' },
    }));
    writeFileSync(join(cwd, 'functions/package.json'), JSON.stringify({
      name: 'firestore-stamp-functions',
      private: true,
      type: 'commonjs',
      main: 'index.cjs',
    }));
    // Unchanged firebase-admin source — the register swap rewrites the imports.
    writeFileSync(join(cwd, 'functions/index.cjs'),
      `const { onValueCreated } = require('firebase-functions/v2/database');
const { getFirestore } = require('firebase-admin/firestore');
exports.stampPresence = onValueCreated('/presence/{uid}/state', async (event) => {
  const uid = event.data.ref.parent.key;
  await getFirestore().doc('users/' + uid).set({ lastSeenAt: event.data.val() });
});
`);
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(cwd, 'functions/node_modules/firebase-functions'),
    );

    let stdout = '';
    let stderr = '';
    command = spawn('node', [
      cliEntry, 'dev', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture',
    ], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    command.stdout?.setEncoding('utf8');
    command.stderr?.setEncoding('utf8');
    command.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    command.stderr?.on('data', (chunk: string) => { stderr += chunk; });

    try {
      const pointer = await waitFor(() => {
        const path = join(cwd, '.pyric/serve.json');
        return existsSync(path)
          ? JSON.parse(readFileSync(path, 'utf8')) as { url: string }
          : null;
      });
      // The worker peer owns the sandbox where data lands — deploy the
      // restrictive ruleset there (as a served page would).
      peer = await connectWorkerPeer(
        `${pointer.url.replace(/^http/, 'ws')}/__pyric/sandbox`,
        { firestoreRules: RULES },
      );
      observer = await connectRemoteSandbox({ url: pointer.url });
      await waitFor(() =>
        stdout.includes('✔ functions 1 onValueCreated trigger') ? true : null);

      // Trigger the function: an RTDB create at the watched path.
      await observer.rtdb.set('presence/u1/state', 'online');

      // ADMIN BYPASS: the function's firebase-admin write landed despite the
      // deny-for-anon ruleset. Read it back through the worker (admin lens).
      const stamped = await waitFor(async () => {
        const snap = (await observer!.channel.op({
          method: 'getDoc',
          path: 'users/u1',
          actAs: { mode: 'admin' },
        })) as { exists: boolean; data?: { json: string } };
        return snap.exists ? snap : null;
      });
      expect(JSON.parse(stamped.data!.json)).toEqual({ lastSeenAt: 'online' });

      // NEGATIVE INVARIANT: a client-lens (signed-out / anon) write to the
      // SAME rules-protected path is DENIED — the fix routes only the server
      // admin context to the bypass lens, never a client lens.
      let clientErr: { code?: string } | undefined;
      try {
        await observer.channel.op({
          method: 'setDoc',
          path: 'users/u1',
          data: { lastSeenAt: 'spoofed' },
          actAs: { mode: 'anon' },
        });
      } catch (e) {
        clientErr = e as { code?: string };
      }
      expect(clientErr?.code).toBe('permission-denied');
      // The denied client write did not mutate the admin-stamped doc.
      const after = (await observer.channel.op({
        method: 'getDoc',
        path: 'users/u1',
        actAs: { mode: 'admin' },
      })) as { exists: boolean; data?: { json: string } };
      expect(JSON.parse(after.data!.json)).toEqual({ lastSeenAt: 'online' });

      expect(stderr).not.toContain('Functions child exited unexpectedly');
    } finally {
      observer?.close();
      observer = undefined;
      await peer?.close().catch(() => {});
      peer = undefined;
      if (command?.exitCode === null) command.kill('SIGKILL');
      command = undefined;
    }
  }, 30_000);

  test('SIGTERM during Functions module evaluation stops the isolated child', async () => {
    if (!existsSync(cliEntry)) throw new Error(`build the CLI first: ${cliEntry}`);
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-functions-startup-stop-'));
    mkdirSync(join(cwd, 'public'));
    mkdirSync(join(cwd, 'functions'));
    writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>fixture</body>');
    writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-project' } }));
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({
      hosting: { public: 'public' },
      functions: { source: 'functions' },
    }));
    writeFileSync(join(cwd, 'functions/package.json'), JSON.stringify({
      name: 'blocked-functions',
      private: true,
      type: 'commonjs',
      main: 'index.cjs',
    }));
    writeFileSync(join(cwd, 'functions/index.cjs'), `
require('node:fs').writeFileSync(${JSON.stringify(join(cwd, 'functions-child.pid'))}, String(process.pid));
require('node:child_process').execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);
`);

    let stdout = '';
    const blockedCommand = spawn('node', [
      cliEntry,
      'dev',
      '--port=0',
      '--host=127.0.0.1',
      '--no-open',
      '--no-capture',
    ], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    blockedCommand.stdout?.setEncoding('utf8');
    blockedCommand.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    let blockedPeer: { close(): Promise<void> } | undefined;
    let childPid: number | undefined;

    try {
      const pointer = await waitFor(() => {
        const path = join(cwd, '.pyric/serve.json');
        return existsSync(path)
          ? JSON.parse(readFileSync(path, 'utf8')) as { url: string }
          : null;
      });
      blockedPeer = await connectWorkerPeer(`${pointer.url.replace(/^http/, 'ws')}/__pyric/sandbox`);
      childPid = await waitFor(() => {
        const path = join(cwd, 'functions-child.pid');
        return existsSync(path) ? Number(readFileSync(path, 'utf8')) : null;
      });

      blockedCommand.kill('SIGTERM');
      const code = await Promise.race([
        new Promise<number>((resolveExit) =>
          blockedCommand.once('exit', (exit) => resolveExit(exit ?? 1))),
        Bun.sleep(5_000).then(() => -1),
      ]);
      expect(code).toBe(0);
      expect(stdout).toContain('Shutting down...');
      await waitFor(() => {
        try {
          process.kill(childPid!, 0);
          return null;
        } catch {
          return true;
        }
      }, 5_000);
    } finally {
      await blockedPeer?.close().catch(() => {});
      if (blockedCommand.exitCode === null) blockedCommand.kill('SIGKILL');
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // Already stopped by the coordinated shutdown path.
        }
      }
    }
  }, 20_000);

  test('an unexpected Functions exit also stops the project dev child', async () => {
    if (!existsSync(cliEntry)) throw new Error(`build the CLI first: ${cliEntry}`);
    const cwd = mkdtempSync(join(tmpdir(), 'pyric-functions-fatal-stop-'));
    mkdirSync(join(cwd, 'public'));
    mkdirSync(join(cwd, 'functions'));
    writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>fixture</body>');
    writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-project' } }));
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({
      hosting: { public: 'public' },
      functions: { source: 'functions' },
    }));
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      private: true,
      scripts: {
        dev: `node -e "require('node:fs').writeFileSync('dev-child.pid', String(process.pid)); setTimeout(() => {}, 60000)"`,
      },
    }));
    writeFileSync(join(cwd, 'functions/package.json'), JSON.stringify({
      name: 'fatal-functions',
      private: true,
      type: 'commonjs',
      main: 'index.cjs',
    }));
    writeFileSync(join(cwd, 'functions/index.cjs'), 'setTimeout(() => process.exit(7), 3000);\n');

    let stderr = '';
    const fatalCommand = spawn('node', [
      cliEntry,
      'dev',
      '--port=0',
      '--host=127.0.0.1',
      '--no-open',
      '--no-capture',
    ], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    fatalCommand.stderr?.setEncoding('utf8');
    fatalCommand.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    let devPid: number | undefined;
    let fatalPeer: { close(): Promise<void> } | undefined;

    try {
      const pointer = await waitFor(() => {
        const path = join(cwd, '.pyric/serve.json');
        return existsSync(path)
          ? JSON.parse(readFileSync(path, 'utf8')) as { url: string }
          : null;
      });
      fatalPeer = await connectWorkerPeer(
        `${pointer.url.replace(/^http/, 'ws')}/__pyric/sandbox`,
      );
      devPid = await waitFor(() => {
        const path = join(cwd, 'dev-child.pid');
        return existsSync(path) ? Number(readFileSync(path, 'utf8')) : null;
      });
      const code = await Promise.race([
        new Promise<number>((resolveExit) =>
          fatalCommand.once('exit', (exit) => resolveExit(exit ?? 1))),
        Bun.sleep(5_000).then(() => -1),
      ]);
      expect(code).toBe(7);
      expect(stderr).toContain('Functions child exited unexpectedly (code 7)');
      await waitFor(() => {
        try {
          process.kill(devPid!, 0);
          return null;
        } catch {
          return true;
        }
      }, 5_000);
    } finally {
      await fatalPeer?.close().catch(() => {});
      if (fatalCommand.exitCode === null) fatalCommand.kill('SIGKILL');
      if (devPid !== undefined) {
        try {
          process.kill(devPid, 'SIGKILL');
        } catch {
          // Expected: fatal Functions shutdown owns and stops the dev child.
        }
      }
    }
  }, 20_000);
});
