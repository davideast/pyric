/**
 * Hosting config resolution and `pyric sandbox` rewrite-only startup (#1825).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  extractHosting,
  hostingNoStaticSiteLine,
  resolveHostingSite,
  wantsSpaRewrite,
} from '../../src/cli/firebase-json.js';
import { functionsChildrenOf, isAlive } from '../functions-http/children.js';
import { resolveNodeExecutable } from '../serve/require-node-on-path.js';
import { trackTempDirs } from '../use-temp-dirs.js';

const CLI_ROOT = resolve(import.meta.dir, '../..');
const REPO_ROOT = resolve(CLI_ROOT, '../..');
const CLI_DIST_ENTRY = join(CLI_ROOT, 'dist/cli/index.js');
const FIREBASE_FUNCTIONS_MODULE = join(REPO_ROOT, 'packages/conformance/node_modules/firebase-functions');

const { makeTempDir, cleanupTempDirs } = trackTempDirs('pyric-firebase-json-');
const startedProcesses: ChildProcess[] = [];
const functionChildPids: number[] = [];

async function waitFor<T>(read: () => T | null | Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(50);
  }
  return null;
}

afterEach(async () => {
  for (const proc of startedProcesses.splice(0)) {
    const pid = proc.pid;
    if (pid !== undefined) {
      for (const fnPid of functionsChildrenOf(pid)) {
        functionChildPids.push(fnPid);
      }
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      await new Promise<void>((resolveStop) => {
        const killTimer = setTimeout(() => {
          proc.kill('SIGKILL');
          resolveStop();
        }, 3_000);
        proc.once('close', () => {
          clearTimeout(killTimer);
          resolveStop();
        });
      });
    }
  }
  for (const pid of functionChildPids.splice(0)) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  cleanupTempDirs();
});

describe('resolveHostingSite (#1825)', () => {
  it('returns null when there is no hosting block', () => {
    const cwd = makeTempDir();
    expect(resolveHostingSite(cwd, null)).toEqual({ publicDir: null, publicLabel: null });
  });

  it('accepts dynamic rewrites or redirects without a public or source directory', () => {
    const cwd = makeTempDir();
    expect(existsSync(join(cwd, 'public'))).toBe(false);
    expect(
      resolveHostingSite(cwd, {
        rewrites: [{ source: '/api/**', function: 'api' }],
      }),
    ).toEqual({ publicDir: null, publicLabel: null });

    expect(
      resolveHostingSite(cwd, {
        rewrites: [{ source: '/run/**', run: { serviceId: 'svc' } }],
      }),
    ).toEqual({ publicDir: null, publicLabel: null });

    expect(
      resolveHostingSite(cwd, {
        redirects: [{ source: '/old', destination: '/new', type: 301 }],
      }),
    ).toEqual({ publicDir: null, publicLabel: null });
  });

  it('refuses a hosting block without public/source when it has no dynamic rewrite or redirect', () => {
    const cwd = makeTempDir();
    expect(() => resolveHostingSite(cwd, {})).toThrow(
      /Must supply a "public" or "source" directory or at least one rewrite or redirect/,
    );
    expect(() => resolveHostingSite(cwd, { rewrites: [], redirects: [] })).toThrow(
      /Must supply a "public" or "source" directory or at least one rewrite or redirect/,
    );
  });

  it('refuses destination rewrites or i18n without a public or source directory', () => {
    const cwd = makeTempDir();
    expect(() =>
      resolveHostingSite(cwd, {
        rewrites: [{ source: '**', destination: '/index.html' }],
      }),
    ).toThrow(/Must supply a "public" or "source" directory when using "destination" rewrites/);

    expect(() =>
      resolveHostingSite(cwd, {
        rewrites: [
          { source: '/api/**', function: 'api' },
          { source: '**', destination: '/index.html' },
        ],
      }),
    ).toThrow(/Must supply a "public" or "source" directory when using "destination" rewrites/);

    expect(() =>
      resolveHostingSite(cwd, {
        i18n: { root: '/localized' },
        rewrites: [{ source: '/api/**', function: 'api' }],
      }),
    ).toThrow(/Must supply a "public" or "source" directory when using "i18n" configuration/);
  });

  it('refuses specifying both source and public', () => {
    const cwd = makeTempDir();
    mkdirSync(join(cwd, 'public'));
    mkdirSync(join(cwd, 'src'));
    expect(() => resolveHostingSite(cwd, { public: 'public', source: 'src' })).toThrow(
      /Can only specify "source" or "public" in a Hosting config, not both/,
    );
  });

  it('resolves existing public or source directories and keeps missing-directory hints', () => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, 'vite.config.ts'), 'export default {};\n');
    expect(() => resolveHostingSite(cwd, { public: 'dist' }, { hosted: true })).toThrow(
      /hosting\.public directory does not exist[\s\S]*pyric\(\{ hosted: true \}\) in vite\.config\.ts/,
    );
    expect(() => resolveHostingSite(cwd, { source: 'app' }, { hosted: true })).toThrow(
      /hosting\.source directory does not exist[\s\S]*pyric\(\{ hosted: true \}\) in vite\.config\.ts/,
    );

    mkdirSync(join(cwd, 'dist'));
    expect(resolveHostingSite(cwd, { public: 'dist' })).toEqual({
      publicDir: join(cwd, 'dist'),
      publicLabel: 'dist',
    });

    mkdirSync(join(cwd, 'app'));
    expect(resolveHostingSite(cwd, { source: 'app' })).toEqual({
      publicDir: null,
      publicLabel: null,
    });
  });

  it('formats distinct startup lines for missing firebase.json, missing hosting, and rewrite-only hosting', () => {
    expect(hostingNoStaticSiteLine(false, false)).toContain('no firebase.json');
    expect(hostingNoStaticSiteLine(true, false)).toContain('has no hosting block');
    expect(hostingNoStaticSiteLine(true, true)).toContain('No static files: hosting.public is not set.');
    expect(extractHosting({ hosting: [{ rewrites: [{ source: '/a', function: 'a' }] }] })).toEqual({
      rewrites: [{ source: '/a', function: 'a' }],
    });
    expect(wantsSpaRewrite({ rewrites: [{ source: '**', destination: '/index.html' }] })).toBe(true);
  });

  it('does not claim in source comments that public is production default', () => {
    const serveSource = readFileSync(join(CLI_ROOT, 'src/cli/serve.ts'), 'utf8');
    const firebaseJsonSource = readFileSync(join(CLI_ROOT, 'src/cli/firebase-json.ts'), 'utf8');
    expect(serveSource).not.toContain("production's default");
    expect(firebaseJsonSource).not.toContain("production's default");
  });
});

describe('pyric sandbox CLI on a rewrite-only hosting block (#1825)', () => {
  it('starts with no public/ directory and reaches the onRequest function through the hosting rewrite', async () => {
    const nodeBin = resolveNodeExecutable();
    if (!existsSync(CLI_DIST_ENTRY)) {
      throw new Error(`Build packages/cli before running CLI test: ${CLI_DIST_ENTRY}`);
    }
    const cwd = makeTempDir();
    writeFileSync(
      join(cwd, 'firebase.json'),
      JSON.stringify({
        functions: { source: 'functions' },
        hosting: {
          rewrites: [{ source: '/api/**', function: 'api' }],
        },
      }),
    );
    writeFileSync(join(cwd, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-rewrite-only' } }));
    mkdirSync(join(cwd, 'functions/node_modules'), { recursive: true });
    writeFileSync(join(cwd, 'functions/package.json'), JSON.stringify({ name: 'functions', main: 'index.cjs' }));
    writeFileSync(
      join(cwd, 'functions/index.cjs'),
      [
        "const { onRequest } = require('firebase-functions/v2/https');",
        'exports.api = onRequest((req, res) => {',
        '  res.status(201).json({ method: req.method, path: req.path, url: req.originalUrl || req.url });',
        '});',
      ].join('\n'),
    );
    symlinkSync(FIREBASE_FUNCTIONS_MODULE, join(cwd, 'functions/node_modules/firebase-functions'));
    expect(existsSync(join(cwd, 'public'))).toBe(false);

    let output = '';
    const child = spawn(
      nodeBin,
      [CLI_DIST_ENTRY, 'sandbox', '--hosted', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
      { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    startedProcesses.push(child);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
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
      throw new Error(`pyric sandbox did not start on rewrite-only hosting block:\n${output}`);
    }
    const baseUrl = pointer.url.replace(/\/$/, '');

    const ready = await waitFor(async () => {
      try {
        const res = await fetch(`${baseUrl}/api/health`);
        return res.status === 201 ? true : null;
      } catch (error) {
        if (error instanceof TypeError) return null;
        throw error;
      }
    }, 30_000);
    if (ready === null) {
      throw new Error(`onRequest function did not become ready behind /api/** rewrite:\n${output}`);
    }

    const response = await fetch(`${baseUrl}/api/messages?limit=3`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      method: 'POST',
      path: '/api/messages',
      url: '/api/messages?limit=3',
    });

    const miss = await fetch(`${baseUrl}/unmatched-static`);
    expect(miss.status).toBe(404);
    expect(output).toContain('No static files: hosting.public is not set.');
    expect(output).not.toContain('hosting.public directory does not exist');
  }, 60_000);

  it('exits non-zero with firebase-tools refusal when hosting block has no root, rewrite, or redirect', () => {
    const nodeBin = resolveNodeExecutable();
    const cwd = makeTempDir();
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ hosting: {} }));
    const result = spawnSync(
      nodeBin,
      [CLI_DIST_ENTRY, 'sandbox', '--hosted', '--port=0', '--host=127.0.0.1', '--no-open', '--no-capture'],
      { cwd, encoding: 'utf8', timeout: 20_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Must supply a "public" or "source" directory');
  }, 30_000);
});
