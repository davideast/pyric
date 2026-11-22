import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectRemoteSandbox, type RemoteSandbox } from '../../src/remote/index.js';

const cliRoot = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliRoot, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');

const tempDirs: string[] = [];
const activeChildren = new Set<ChildProcess>();

async function waitFor<T>(
  read: () => T | null | Promise<T | null>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(25);
  }
  throw new Error('timed out waiting for pyric sandbox outcome');
}

async function stopSandboxProcess(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) {
    activeChildren.delete(child);
    return child.exitCode;
  }
  child.kill('SIGTERM');
  const code = await Promise.race([
    new Promise<number>((resolveExit) => {
      child.once('exit', (exitCode) => resolveExit(exitCode ?? 1));
    }),
    Bun.sleep(5_000).then(() => -1),
  ]);
  if (code === -1 && child.exitCode === null) {
    child.kill('SIGKILL');
  }
  activeChildren.delete(child);
  return code;
}

afterEach(async () => {
  for (const child of [...activeChildren]) {
    await stopSandboxProcess(child);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('pyric sandbox with an unbuilt Functions source (#1812)', () => {
  test('warns once, serves hosting cleanly, and loads triggers after building and restarting', async () => {
    if (!existsSync(cliEntry)) {
      throw new Error(`build the CLI first: ${cliEntry}`);
    }

    const cwd = mkdtempSync(join(tmpdir(), 'pyric-unbuilt-functions-'));
    tempDirs.push(cwd);

    mkdirSync(join(cwd, 'public'), { recursive: true });
    mkdirSync(join(cwd, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(cwd, 'public/index.html'), '<!doctype html><body>hosted-ok</body>');
    writeFileSync(
      join(cwd, '.firebaserc'),
      JSON.stringify({ projects: { default: 'demo-project' } }),
    );
    writeFileSync(
      join(cwd, 'firebase.json'),
      JSON.stringify({
        hosting: { public: 'public' },
        functions: { source: 'functions' },
      }),
    );
    writeFileSync(
      join(cwd, 'functions/package.json'),
      JSON.stringify({
        name: 'unbuilt-functions-fixture',
        private: true,
        main: 'lib/index.js',
      }),
    );
    symlinkSync(
      join(repoRoot, 'packages/conformance/node_modules/firebase-functions'),
      join(cwd, 'functions/node_modules/firebase-functions'),
    );

    const startSandbox = (): {
      child: ChildProcess;
      stdout: () => string;
      stderr: () => string;
    } => {
      let out = '';
      let err = '';
      const child = spawn(
        'node',
        [
          cliEntry,
          'sandbox',
          '--port=0',
          '--host=127.0.0.1',
          '--hosted',
          '--no-open',
          '--no-capture',
          '--no-run',
        ],
        { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      activeChildren.add(child);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        err += chunk;
      });
      return { child, stdout: () => out, stderr: () => err };
    };

    // First run: functions/lib/index.js does not exist yet.
    const firstRun = startSandbox();
    const firstPointer = await waitFor(() => {
      const pointerPath = join(cwd, '.pyric/serve.json');
      if (!existsSync(pointerPath)) return null;
      return JSON.parse(readFileSync(pointerPath, 'utf8')) as { url: string };
    });

    const hostingResponse = await fetch(`${firstPointer.url}/index.html`);
    expect(hostingResponse.status).toBe(200);
    expect(await hostingResponse.text()).toContain('hosted-ok');

    const firstStderr = firstRun.stderr();
    const warningMatches = firstStderr
      .split('\n')
      .filter((line) => line.includes('has no entry at "lib/index.js"'));
    expect(warningMatches).toHaveLength(1);
    expect(warningMatches[0]).toContain('"functions"');
    expect(warningMatches[0]).toContain('"lib/index.js"');
    expect(firstStderr).not.toContain('Functions entry does not exist');

    const firstExit = await stopSandboxProcess(firstRun.child);
    expect(firstExit).toBe(0);

    // Build functions/lib/index.js and restart pyric sandbox.
    mkdirSync(join(cwd, 'functions/lib'), { recursive: true });
    writeFileSync(
      join(cwd, 'functions/lib/index.js'),
      [
        "const { onValueCreated } = require('firebase-functions/v2/database');",
        "const { onRequest } = require('firebase-functions/v2/https');",
        "exports.ping = onRequest((_req, res) => res.status(200).send('built-ok'));",
        "exports.makeUppercase = onValueCreated('/messages/{id}/original', (event) => (",
        "  event.data.ref.parent.child('uppercase').set(String(event.data.val()).toUpperCase())",
        '));',
      ].join('\n'),
    );

    const secondRun = startSandbox();
    let observer: RemoteSandbox | undefined;
    try {
      const secondPointer = await waitFor(() => {
        const pointerPath = join(cwd, '.pyric/serve.json');
        if (!existsSync(pointerPath)) return null;
        return JSON.parse(readFileSync(pointerPath, 'utf8')) as { url: string };
      });
      await waitFor(() => {
        if (secondRun.stdout().includes('1 onValueCreated trigger')) return true;
        return null;
      });
      expect(secondRun.stderr()).not.toContain('has no entry at');

      const fnResponse = await fetch(`${secondPointer.url}/demo-project/us-central1/ping`);
      expect(fnResponse.status).toBe(200);
      expect(await fnResponse.text()).toBe('built-ok');

      observer = await connectRemoteSandbox({ url: secondPointer.url, cwd });
      await observer.rtdb.set('messages/m1/original', 'ready');
      const uppercased = await waitFor(async () => {
        if (observer === undefined) return null;
        const val = await observer.rtdb.get('messages/m1/uppercase');
        return val === 'READY' ? val : null;
      });
      expect(uppercased).toBe('READY');
    } finally {
      observer?.close();
    }

    const secondExit = await stopSandboxProcess(secondRun.child);
    expect(secondExit).toBe(0);
  }, 30_000);
});
