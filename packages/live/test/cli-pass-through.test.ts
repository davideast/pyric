/**
 * `pyric-live --pass-through`: CLI flag parsing, start-time validation parity
 * with `pyricLive({ passThrough })`, `/__pyric/health` exposure, and real
 * `@pyric/live/register` subprocess pass-through and refusal behavior (#2135).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { livePassThroughLine } from '@pyric/cli/serve/internal/live-host';
import { INSTALLED_SDK_SPECIFIERS } from '@pyric/cli/vite/internal/supplied-rows';
import { parseLiveHostArgs } from '../src/host-args.js';
import { PASS_THROUGH_CANDIDATES } from '../src/refusal.js';

const liveDir = resolve(import.meta.dir, '..');
const repoRoot = resolve(liveDir, '../..');
const cliDir = join(repoRoot, 'packages/cli');
const liveCliDist = join(liveDir, 'dist/cli.js');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const realFirebaseDir = realpathSync(dirname(requireFromRepo.resolve('firebase/package.json')));
const realFirebaseFunctionsDir = realpathSync(
  dirname(createRequire(join(realFirebaseDir, 'package.json')).resolve('@firebase/functions/package.json')),
);
const { freePort: freeLoopbackPort } = (await import(
  new URL('../../../test/apps/ports.ts', import.meta.url).href
)) as {
  freePort: () => Promise<number>;
};

describe('parseLiveHostArgs', () => {
  test('defaults to an empty pass-through list and forwards remaining host flags unchanged', () => {
    expect(parseLiveHostArgs(['--port', '4000', '--host', '127.0.0.1', '--project', 'acme-live', '--no-open'])).toEqual({
      kind: 'start',
      allowRemotePeers: false,
      passThrough: [],
      hostArgv: ['--port', '4000', '--host', '127.0.0.1', '--project', 'acme-live', '--no-open'],
    });
  });

  test('supports repeatable --pass-through, --pass-through=a,b, comma lists, trimming, and deduplication', () => {
    const repeated = parseLiveHostArgs([
      '--pass-through',
      'firebase/functions',
      '--port',
      '3474',
      '--pass-through',
      'firebase/remote-config',
      '--allow-remote-live',
    ]);
    expect(repeated).toEqual({
      kind: 'start',
      allowRemotePeers: true,
      passThrough: ['firebase/functions', 'firebase/remote-config'],
      hostArgv: ['--port', '3474'],
    });

    const commaAndMixed = parseLiveHostArgs([
      '--pass-through=firebase/functions, firebase/analytics',
      '--no-open',
      '--pass-through',
      'firebase/remote-config,firebase/functions',
    ]);
    expect(commaAndMixed).toEqual({
      kind: 'start',
      allowRemotePeers: false,
      passThrough: ['firebase/functions', 'firebase/analytics', 'firebase/remote-config'],
      hostArgv: ['--no-open'],
    });

    const allCandidates = parseLiveHostArgs([`--pass-through=${PASS_THROUGH_CANDIDATES.join(',')}`]);
    expect(allCandidates).toEqual({
      kind: 'start',
      allowRemotePeers: false,
      passThrough: [...PASS_THROUGH_CANDIDATES],
      hostArgv: [],
    });
  });

  test('recognizes --help/-h before -- and preserves bare -- for child-command refusal', () => {
    expect(parseLiveHostArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseLiveHostArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseLiveHostArgs(['--pass-through', '--help'])).toEqual({ kind: 'help' });

    const withChildSeparator = parseLiveHostArgs([
      '--pass-through',
      'firebase/functions',
      '--',
      'node',
      'server.js',
      '--help',
    ]);
    expect(withChildSeparator).toEqual({
      kind: 'start',
      allowRemotePeers: false,
      passThrough: ['firebase/functions'],
      hostArgv: ['--', 'node', 'server.js', '--help'],
    });
  });

  test('fails fast when --pass-through is missing a value or contains empty comma entries', () => {
    for (const argv of [
      ['--pass-through'],
      ['--pass-through', '--no-open'],
      ['--pass-through', '--', 'node', 'server.js'],
      ['--pass-through='],
      ['--pass-through', ''],
      ['--pass-through', '   '],
    ]) {
      const parsed = parseLiveHostArgs(argv);
      expect(parsed.kind, JSON.stringify(argv)).toBe('error');
      if (parsed.kind === 'error') {
        expect(parsed.message).toContain('pyric-live: --pass-through needs a Firebase import');
      }
    }

    for (const argv of [
      ['--pass-through=firebase/functions,'],
      ['--pass-through=,firebase/functions'],
      ['--pass-through=firebase/functions,,firebase/remote-config'],
      ['--pass-through', 'firebase/functions, ,firebase/remote-config'],
    ]) {
      const parsed = parseLiveHostArgs(argv);
      expect(parsed.kind, JSON.stringify(argv)).toBe('error');
      if (parsed.kind === 'error') {
        expect(parsed.message).toContain('pyric-live: --pass-through contains an empty entry');
      }
    }
  });

  test('validates entries like pyricLive({ passThrough }), rejecting served rows, Firestore Lite, firebase-admin, and @firebase/*', () => {
    for (const served of INSTALLED_SDK_SPECIFIERS) {
      const parsed = parseLiveHostArgs(['--pass-through', served]);
      expect(parsed.kind, served).toBe('error');
      if (parsed.kind === 'error') {
        expect(parsed.message).toBe(
          `pyric-live: passThrough lists ${served}, which live mode already serves and observes; remove it.`,
        );
      }
    }

    const lite = parseLiveHostArgs(['--pass-through=firebase/firestore/lite']);
    expect(lite.kind).toBe('error');
    if (lite.kind === 'error') {
      expect(lite.message).toContain('live mode serves this service as firebase/firestore');
    }

    const admin = parseLiveHostArgs(['--pass-through', 'firebase-admin']);
    expect(admin.kind).toBe('error');
    if (admin.kind === 'error') {
      expect(admin.message).toBe(
        'pyric-live: passThrough lists firebase-admin, which live mode already serves and observes; remove it.',
      );
    }

    const adminSubpath = parseLiveHostArgs(['--pass-through=firebase-admin/app']);
    expect(adminSubpath.kind).toBe('error');
    if (adminSubpath.kind === 'error') {
      expect(adminSubpath.message).toContain('passThrough lists firebase-admin/app');
    }

    const sdkPkg = parseLiveHostArgs(['--pass-through', '@firebase/functions']);
    expect(sdkPkg.kind).toBe('error');
    if (sdkPkg.kind === 'error') {
      expect(sdkPkg.message).toBe(
        'pyric-live: passThrough lists @firebase/functions, an SDK package name; list firebase/functions, the import apps write.',
      );
    }

    const unknown = parseLiveHostArgs(['--pass-through', 'firebase/not-a-service']);
    expect(unknown.kind).toBe('error');
    if (unknown.kind === 'error') {
      expect(unknown.message).toContain('is not a Firebase import live mode can pass through');
    }
  });
});

describe('pyric-live --pass-through CLI and register subprocess integration', () => {
  const tempDirs: string[] = [];
  const childProcesses: ChildProcess[] = [];

  afterEach(async () => {
    for (const proc of childProcesses.splice(0)) {
      await stopChild(proc);
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshWorkspace(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-pt-')));
    tempDirs.push(dir);
    mkdirSync(join(dir, 'node_modules/@pyric'), { recursive: true });
    mkdirSync(join(dir, 'node_modules/@firebase'), { recursive: true });
    symlinkSync(cliDir, join(dir, 'node_modules/@pyric/cli'));
    symlinkSync(liveDir, join(dir, 'node_modules/@pyric/live'));
    symlinkSync(realFirebaseDir, join(dir, 'node_modules/firebase'));
    symlinkSync(realFirebaseFunctionsDir, join(dir, 'node_modules/@firebase/functions'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'acme-live-pt', type: 'module' }));
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'acme-live' } }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(join(dir, 'public/index.html'), '<!doctype html><title>acme</title>');
    return dir;
  }

  async function stopChild(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((done) => proc.once('exit', () => done()));
    proc.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, 3_000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }

  interface StartedHost {
    readonly proc: ChildProcess;
    readonly url: string;
    readonly health: { readonly live?: Record<string, unknown> };
    readonly output: () => string;
  }

  async function startLiveHostProcess(dir: string, extraArgs: readonly string[]): Promise<StartedHost> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const port = await freeLoopbackPort();
      const url = `http://127.0.0.1:${port}`;
      const scanNotice = `port ${port} is in use`;
      const pointerPath = join(dir, '.pyric/serve.json');
      rmSync(join(dir, '.pyric'), { recursive: true, force: true });

      const proc = spawn(
        'node',
        [liveCliDist, '--no-open', '--host', '127.0.0.1', '--port', String(port), '--project', 'acme-live', ...extraArgs],
        {
          cwd: dir,
          env: { PATH: process.env.PATH, HOME: dir },
        },
      );
      childProcesses.push(proc);

      let combined = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        combined += chunk.toString();
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        combined += chunk.toString();
      });

      const deadline = Date.now() + 30_000;
      let retryCollision = false;
      let lastProbeError = '';
      while (Date.now() < deadline) {
        if (attempt < 3 && combined.includes(scanNotice)) {
          retryCollision = true;
          break;
        }
        if (proc.exitCode !== null || proc.signalCode !== null) {
          throw new Error(`pyric-live exited early (${String(proc.exitCode ?? proc.signalCode)}):\n${combined}`);
        }
        if (existsSync(pointerPath)) {
          try {
            const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as { port?: number; token?: string };
            if (pointer.port === port && typeof pointer.token === 'string') {
              const res = await fetch(`${url}/__pyric/health`, {
                headers: { 'x-pyric-session-token': pointer.token },
              });
              if (res.ok) {
                const body = (await res.json()) as { sandboxConnected?: boolean; live?: Record<string, unknown> };
                if (body.live !== undefined && body.sandboxConnected !== false) {
                  return { proc, url, health: body, output: () => combined };
                }
              }
            }
          } catch (error: unknown) {
            lastProbeError = error instanceof Error ? error.message : String(error);
          }
        }
        await new Promise<void>((done) => setTimeout(done, 150));
      }

      await stopChild(proc);
      if (!retryCollision) {
        const probeNote = lastProbeError.length > 0 ? `\nlast probe error: ${lastProbeError}` : '';
        throw new Error(`timed out waiting for pyric-live health at ${url}:${probeNote}\n${combined}`);
      }
    }
    throw new Error('unable to allocate a free loopback port for pyric-live');
  }

  async function runRegisterProbe(dir: string, scriptPath: string): Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }> {
    return new Promise((done) => {
      const proc = spawn('node', ['--import', '@pyric/live/register', scriptPath], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir },
      });
      childProcesses.push(proc);
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      proc.once('exit', (code) => done({ code, stdout, stderr }));
    });
  }

  test('documents --pass-through in --help and fails fast with exit 1 on invalid flags or specifiers', () => {
    const help = spawnSync('node', [liveCliDist, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--pass-through <specifier>');

    for (const [args, expectedText] of [
      [['--pass-through', 'firebase/database'], 'passThrough lists firebase/database, which live mode already serves and observes'],
      [['--pass-through=firebase/firestore/lite'], 'live mode serves this service as firebase/firestore'],
      [['--pass-through', 'firebase-admin'], 'passThrough lists firebase-admin, which live mode already serves and observes'],
      [['--pass-through', '@firebase/functions'], 'an SDK package name; list firebase/functions'],
      [['--pass-through'], '--pass-through needs a Firebase import'],
      [['--pass-through='], '--pass-through needs a Firebase import'],
      [['--pass-through=firebase/functions,'], '--pass-through contains an empty entry'],
    ] as const) {
      const res = spawnSync('node', [liveCliDist, ...args], { encoding: 'utf8' });
      expect(res.status, JSON.stringify(args)).toBe(1);
      expect(res.stderr).toContain(expectedText);
      expect(res.stderr).not.toContain('pyric-live: pyric-live:');
    }
  }, 30_000);

  test('exposes --pass-through in /__pyric/health and lets @pyric/live/register pass listed SDKs through while refusing unlisted ones', async () => {
    const dir = freshWorkspace();
    const probePath = join(dir, 'probe-pass-through.mjs');
    writeFileSync(
      probePath,
      `import { initializeApp } from 'firebase/app';

const app = initializeApp({
  apiKey: 'demo-key',
  authDomain: 'acme-live.firebaseapp.com',
  projectId: 'acme-live',
  databaseURL: 'https://acme-live-default-rtdb.firebaseio.com',
  appId: '1:1:web:1',
});

async function tryImport(specifier, inspect) {
  try {
    const mod = await import(specifier);
    const resolved = import.meta.resolve(specifier);
    return { ok: true, resolved, detail: inspect ? inspect(mod) : null };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
    return { ok: false, code, message: error instanceof Error ? error.message : String(error) };
  }
}

const firestore = await tryImport('firebase/firestore', (mod) => typeof mod.getFirestore);
const database = await tryImport('firebase/database', (mod) => typeof mod.getDatabase);
const functions = await tryImport('firebase/functions', (mod) => mod.getFunctions(app).app === app);
const analytics = await tryImport('firebase/analytics');
const directSdkPkg = await tryImport('@firebase/functions');

console.log('PROBE_RESULT ' + JSON.stringify({ firestore, database, functions, analytics, directSdkPkg }));
process.exit(0);
`,
    );

    const passed = ['firebase/functions', 'firebase/remote-config'];
    const host = await startLiveHostProcess(dir, [
      '--pass-through',
      'firebase/functions',
      '--pass-through=firebase/remote-config,firebase/functions',
    ]);
    try {
      expect(host.output()).toContain('pyric-live: live mode for the Firebase project acme-live.');
      for (const specifier of passed) {
        expect(host.output()).toContain(`pyric-live: ${livePassThroughLine(specifier)}`);
      }
      expect(host.health.live?.projectId).toBe('acme-live');
      expect(host.health.live?.passThrough).toEqual(passed);

      const probe = await runRegisterProbe(dir, probePath);
      expect(probe.code, `stderr:\n${probe.stderr}\nstdout:\n${probe.stdout}`).toBe(0);
      expect(probe.stderr).toContain(`@pyric/live/register: ${livePassThroughLine('firebase/functions')}`);
      expect(probe.stderr).toContain(`@pyric/live/register: ${livePassThroughLine('firebase/remote-config')}`);
      expect(probe.stderr).toContain('@pyric/live/register: reporting calls to the live host at ');

      const resultLine = probe.stdout.split('\n').find((line) => line.startsWith('PROBE_RESULT '));
      expect(resultLine, probe.stdout).toBeDefined();
      const result = JSON.parse((resultLine ?? '').slice('PROBE_RESULT '.length)) as {
        firestore: { ok: boolean; resolved?: string; detail?: string };
        database: { ok: boolean; resolved?: string; detail?: string };
        functions: { ok: boolean; resolved?: string; detail?: boolean };
        analytics: { ok: boolean; code?: string };
        directSdkPkg: { ok: boolean; code?: string };
      };

      const sdkUrlPrefix = pathToFileURL(`${realFirebaseDir}/`).href;
      expect(result.firestore.ok).toBe(true);
      expect(result.firestore.resolved).toEndWith('/live-rows/firebase/firestore.js');
      expect(result.database.ok).toBe(true);
      expect(result.database.resolved).toEndWith('/live-rows/firebase/database.js');
      expect(result.functions.ok).toBe(true);
      expect(result.functions.resolved?.startsWith(sdkUrlPrefix)).toBe(true);
      expect(result.functions.detail).toBe(true);
      expect(result.analytics.ok).toBe(false);
      expect(result.analytics.code).toBe('PYRIC_LIVE_REFUSED');
      expect(result.directSdkPkg.ok).toBe(false);
      expect(result.directSdkPkg.code).toBe('PYRIC_REAL_SDK_STOPPED');
    } finally {
      await stopChild(host.proc);
    }

    // Without --pass-through, /__pyric/health omits live.passThrough and register refuses firebase/functions.
    const defaultHost = await startLiveHostProcess(dir, []);
    try {
      expect(defaultHost.health.live).toBeDefined();
      expect('passThrough' in (defaultHost.health.live ?? {})).toBe(false);

      const probe = await runRegisterProbe(dir, probePath);
      expect(probe.code, `stderr:\n${probe.stderr}\nstdout:\n${probe.stdout}`).toBe(0);
      const resultLine = probe.stdout.split('\n').find((line) => line.startsWith('PROBE_RESULT '));
      expect(resultLine, probe.stdout).toBeDefined();
      const result = JSON.parse((resultLine ?? '').slice('PROBE_RESULT '.length)) as {
        functions: { ok: boolean; code?: string };
      };
      expect(result.functions.ok).toBe(false);
      expect(result.functions.code).toBe('PYRIC_LIVE_REFUSED');
    } finally {
      await stopChild(defaultHost.proc);
    }
  }, 90_000);
});
