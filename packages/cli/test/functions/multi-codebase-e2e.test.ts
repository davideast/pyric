/**
 * Live end-to-end tests for multi-codebase `firebase.json` execution under
 * `pyric sandbox --hosted`:
 *  1. Boots two isolated codebases (`api` and `admin`) with separate `.env`
 *     files, routes Hosting rewrites and emulator paths cleanly to each child,
 *     verifies zero env bleed across codebases, and verifies codebase tags in
 *     CLI output.
 *  2. Verifies duplicate export names across codebases fail startup with a
 *     clear diagnostic and leave zero orphan child processes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { functionsChildrenOf, isAlive } from '../functions-http/children.js';
import { resolveNodeExecutable } from '../serve/require-node-on-path.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const CLI_ROOT = resolve(import.meta.dir, '../..');
const REPO_ROOT = resolve(CLI_ROOT, '../..');
const CLI_DIST_ENTRY = join(CLI_ROOT, 'dist/cli/index.js');
const FIREBASE_FUNCTIONS_MODULE = join(
  REPO_ROOT,
  'packages/conformance/node_modules/firebase-functions',
);

const tempDirs = trackTempDirs('pyric-multi-codebase-e2e-');
const startedProcesses: ChildProcess[] = [];

async function waitFor<T>(
  read: () => T | null | Promise<T | null>,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(50);
  }
  return null;
}

function stageCodebase(
  cwd: string,
  dirName: string,
  indexSource: string,
  dotenvContent: string,
): void {
  const base = join(cwd, dirName);
  mkdirSync(join(base, 'node_modules'), { recursive: true });
  writeFileSync(
    join(base, 'package.json'),
    JSON.stringify({ name: dirName, private: true, main: 'index.cjs' }),
  );
  writeFileSync(join(base, 'index.cjs'), indexSource);
  writeFileSync(join(base, '.env'), dotenvContent);
  symlinkSync(FIREBASE_FUNCTIONS_MODULE, join(base, 'node_modules/firebase-functions'));
}

afterEach(async () => {
  const orphanPids: number[] = [];
  for (const proc of startedProcesses.splice(0)) {
    const pid = proc.pid;
    if (pid !== undefined) {
      orphanPids.push(...functionsChildrenOf(pid));
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolveStop();
        }, 3_000);
        proc.once('close', () => {
          clearTimeout(timer);
          resolveStop();
        });
      });
    }
  }
  for (const pid of orphanPids) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  tempDirs.cleanupTempDirs();
});

describe('multi-codebase firebase.json under pyric sandbox --hosted', () => {
  test('loads isolated codebases, preserves env isolation, and routes Hosting rewrites across codebases', async () => {
    const nodeBin = resolveNodeExecutable();
    if (!existsSync(CLI_DIST_ENTRY)) {
      throw new Error(`Build packages/cli before running E2E test: ${CLI_DIST_ENTRY}`);
    }

    const cwd = tempDirs.makeTempDir();
    writeFileSync(
      join(cwd, '.firebaserc'),
      JSON.stringify({ projects: { default: 'demo-multi-cb' } }),
    );
    writeFileSync(
      join(cwd, 'firebase.json'),
      JSON.stringify({
        functions: [
          { codebase: 'api', source: 'functions-api' },
          { codebase: 'admin', source: 'functions-admin' },
        ],
        hosting: {
          rewrites: [
            { source: '/api/**', function: 'apiPing' },
            { source: '/admin/**', function: { functionId: 'adminPing', region: 'europe-west1' } },
          ],
        },
      }),
    );

    stageCodebase(
      cwd,
      'functions-api',
      [
        "const { onRequest } = require('firebase-functions/v2/https');",
        'exports.apiPing = onRequest((req, res) => {',
        '  res.json({',
        "    from: 'api',",
        '    path: req.path,',
        '    apiOnly: process.env.API_ONLY ?? null,',
        '    adminOnly: process.env.ADMIN_ONLY ?? null,',
        '    sharedKey: process.env.SHARED_KEY ?? null,',
        '  });',
        '});',
      ].join('\n'),
      'API_ONLY=alpha-secret\nSHARED_KEY=from-api\n',
    );

    stageCodebase(
      cwd,
      'functions-admin',
      [
        "const { onRequest } = require('firebase-functions/v2/https');",
        "exports.adminPing = onRequest({ region: 'europe-west1' }, (req, res) => {",
        '  res.json({',
        "    from: 'admin',",
        '    path: req.path,',
        '    apiOnly: process.env.API_ONLY ?? null,',
        '    adminOnly: process.env.ADMIN_ONLY ?? null,',
        '    sharedKey: process.env.SHARED_KEY ?? null,',
        '  });',
        '});',
      ].join('\n'),
      'ADMIN_ONLY=beta-secret\nSHARED_KEY=from-admin\n',
    );

    let output = '';
    const cli = spawn(
      nodeBin,
      [CLI_DIST_ENTRY, 'sandbox', '--hosted', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
      { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    startedProcesses.push(cli);
    cli.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    cli.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    const pointer = await waitFor(() => {
      const servePath = join(cwd, '.pyric/serve.json');
      if (!existsSync(servePath)) return null;
      const raw = readFileSync(servePath, 'utf8');
      if (raw.trim() === '') return null;
      return JSON.parse(raw) as { url: string };
    }, 20_000);
    if (pointer === null) {
      throw new Error(`pyric sandbox did not start on multi-codebase project:\n${output}`);
    }
    const baseUrl = pointer.url.replace(/\/$/, '');

    const ready = await waitFor(async () => {
      try {
        const res = await fetch(`${baseUrl}/api/health`);
        return res.status === 200 ? true : null;
      } catch {
        return null;
      }
    }, 30_000);
    if (ready === null) {
      throw new Error(`multi-codebase functions did not become ready:\n${output}`);
    }

    const apiRes = await fetch(`${baseUrl}/api/items`);
    expect(apiRes.status).toBe(200);
    expect(await apiRes.json()).toEqual({
      from: 'api',
      path: '/api/items',
      apiOnly: 'alpha-secret',
      adminOnly: null,
      sharedKey: 'from-api',
    });

    const adminRes = await fetch(`${baseUrl}/admin/dashboard`);
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toEqual({
      from: 'admin',
      path: '/admin/dashboard',
      apiOnly: null,
      adminOnly: 'beta-secret',
      sharedKey: 'from-admin',
    });

    // Direct emulator URLs also route cleanly to each codebase.
    const directAdmin = await fetch(`${baseUrl}/demo-multi-cb/europe-west1/adminPing/check`);
    expect(directAdmin.status).toBe(200);
    expect(await directAdmin.json()).toEqual({
      from: 'admin',
      path: '/check',
      apiOnly: null,
      adminOnly: 'beta-secret',
      sharedKey: 'from-admin',
    });

    // Startup output and served lines preserve codebase tags.
    expect(output).toContain('[api]');
    expect(output).toContain('[admin]');
  }, 60_000);

  test('fails with a clear diagnostic and exits non-zero when two codebases export the same function name', async () => {
    const nodeBin = resolveNodeExecutable();
    if (!existsSync(CLI_DIST_ENTRY)) {
      throw new Error(`Build packages/cli before running E2E test: ${CLI_DIST_ENTRY}`);
    }

    const cwd = tempDirs.makeTempDir();
    writeFileSync(
      join(cwd, '.firebaserc'),
      JSON.stringify({ projects: { default: 'demo-dup-cb' } }),
    );
    writeFileSync(
      join(cwd, 'firebase.json'),
      JSON.stringify({
        functions: [
          { codebase: 'first', source: 'functions-first' },
          { codebase: 'second', source: 'functions-second' },
        ],
      }),
    );

    const dupSource = [
      "const { onRequest } = require('firebase-functions/v2/https');",
      "exports.sharedExport = onRequest((_req, res) => res.send('dup'));",
    ].join('\n');
    stageCodebase(cwd, 'functions-first', dupSource, '');
    stageCodebase(cwd, 'functions-second', dupSource, '');

    let output = '';
    const cli = spawn(
      nodeBin,
      [CLI_DIST_ENTRY, 'sandbox', '--hosted', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
      { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    startedProcesses.push(cli);
    cli.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    cli.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    const exitCode = await new Promise<number | null>((resolveExit) => {
      const timer = setTimeout(() => resolveExit(null), 30_000);
      cli.once('close', (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });

    expect(exitCode).toBe(2);
    expect(output).toContain('duplicate Functions export name');
    expect(output).toContain('"sharedExport"');
    expect(output).toContain('"first"');
    expect(output).toContain('"second"');
    if (cli.pid !== undefined) {
      expect(functionsChildrenOf(cli.pid)).toEqual([]);
    }
  }, 45_000);
});
