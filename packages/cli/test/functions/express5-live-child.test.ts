/**
 * Live isolated-child E2E test for Express 5 (`firebase-functions@7.4.0` /
 * `express@5.2.1`) HTTP serving under `pyric sandbox --hosted`:
 *  - Verifies nested/bracketed query parameters (`nested[k]=v&deep[a][b]=c`)
 *    parse via the `'extended'` query parser through the real gateway and child.
 *  - Verifies bodyless `GET`, `DELETE`, and empty `POST` requests see
 *    `req.body` normalized to `{}` while JSON `POST` preserves parsed `req.body`
 *    and `req.rawBody`.
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
const EXPRESS_5_DIR = join(REPO_ROOT, 'node_modules/express');
const CONFORMANCE_FF_DIR = join(
  REPO_ROOT,
  'packages/conformance/node_modules/firebase-functions',
);

const tempDirs = trackTempDirs('pyric-express5-live-child-');
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

describe('Express 5 (firebase-functions@7.4.0) live isolated child E2E', () => {
  test('serves nested query params and normalized bodyless req.body through pyric sandbox --hosted', async () => {
    const nodeBin = resolveNodeExecutable();
    if (!existsSync(CLI_DIST_ENTRY)) {
      throw new Error(`Build packages/cli before running E2E test: ${CLI_DIST_ENTRY}`);
    }
    const expressPkg = JSON.parse(readFileSync(join(EXPRESS_5_DIR, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(expressPkg.version.startsWith('5.')).toBe(true);

    const cwd = tempDirs.makeTempDir();
    writeFileSync(
      join(cwd, '.firebaserc'),
      JSON.stringify({ projects: { default: 'demo-express5-e2e' } }),
    );
    writeFileSync(
      join(cwd, 'firebase.json'),
      JSON.stringify({
        functions: { source: 'functions' },
        hosting: {
          rewrites: [{ source: '/api/**', function: 'echo' }],
        },
      }),
    );

    const fnDir = join(cwd, 'functions');
    const ffDir = join(fnDir, 'node_modules/firebase-functions');
    mkdirSync(join(ffDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(fnDir, 'package.json'),
      JSON.stringify({ name: 'express5-e2e-fn', private: true, main: 'index.cjs' }),
    );
    // Stage a firebase-functions package whose `express` resolves to Express 5
    // while delegating `v2/https` to the real firebase-functions SDK.
    writeFileSync(
      join(ffDir, 'package.json'),
      JSON.stringify({
        name: 'firebase-functions',
        version: '7.4.0',
        exports: {
          '.': './index.cjs',
          './v2/https': './v2-https.cjs',
        },
      }),
    );
    writeFileSync(join(ffDir, 'index.cjs'), 'module.exports = {};\n');
    writeFileSync(
      join(ffDir, 'v2-https.cjs'),
      `module.exports = require(${JSON.stringify(join(CONFORMANCE_FF_DIR, 'lib/v2/providers/https.js'))});\n`,
    );
    symlinkSync(EXPRESS_5_DIR, join(ffDir, 'node_modules/express'));

    writeFileSync(
      join(fnDir, 'index.cjs'),
      [
        "const { onRequest } = require('firebase-functions/v2/https');",
        'exports.echo = onRequest((req, res) => {',
        '  res.json({',
        '    method: req.method,',
        '    query: req.query,',
        '    bodyType: typeof req.body,',
        '    body: req.body,',
        "    rawBody: Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : null,",
        '  });',
        '});',
      ].join('\n'),
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
      throw new Error(`pyric sandbox did not start:\n${output}`);
    }
    const baseUrl = pointer.url.replace(/\/$/, '');

    const ready = await waitFor(async () => {
      try {
        const res = await fetch(`${baseUrl}/api/ready`);
        return res.status === 200 ? true : null;
      } catch {
        return null;
      }
    }, 30_000);
    if (ready === null) {
      throw new Error(`Express 5 function did not become ready:\n${output}`);
    }

    const getRes = await fetch(
      `${baseUrl}/api/search?nested[k]=v&deep[a][b]=c&tags[0]=x&tags[1]=y`,
    );
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({
      method: 'GET',
      query: { nested: { k: 'v' }, deep: { a: { b: 'c' } }, tags: ['x', 'y'] },
      bodyType: 'object',
      body: {},
      rawBody: null,
    });

    const deleteRes = await fetch(`${baseUrl}/demo-express5-e2e/us-central1/echo`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({
      method: 'DELETE',
      query: {},
      bodyType: 'object',
      body: {},
      rawBody: null,
    });

    const emptyPostRes = await fetch(`${baseUrl}/api/empty`, {
      method: 'POST',
      headers: { 'content-length': '0' },
    });
    expect(emptyPostRes.status).toBe(200);
    expect(await emptyPostRes.json()).toEqual({
      method: 'POST',
      query: {},
      bodyType: 'object',
      body: {},
      rawBody: null,
    });

    const jsonPostRes = await fetch(`${baseUrl}/api/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'express5', count: 2 }),
    });
    expect(jsonPostRes.status).toBe(200);
    expect(await jsonPostRes.json()).toEqual({
      method: 'POST',
      query: {},
      bodyType: 'object',
      body: { hello: 'express5', count: 2 },
      rawBody: '{"hello":"express5","count":2}',
    });
  }, 60_000);
});
