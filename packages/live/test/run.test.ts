/**
 * `pyric-live run`: runs one command under `@pyric/live/register` against an
 * already-running live host (`pyric-live` or Vite with `pyricLive()`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_WAIT_SECONDS,
  LIVE_RUN_USAGE,
  buildLiveChildEnv,
  liveRegisterModuleUrl,
  notALiveHostMessage,
  parseLiveRunInvocation,
  runLiveRun,
  sandboxHostRefusalMessage,
  tokenGatedHostMessage,
} from '../src/run.js';

const liveDir = resolve(import.meta.dir, '..');
const repoRoot = resolve(liveDir, '../..');
const cliDir = join(repoRoot, 'packages/cli');
const liveCliDist = join(liveDir, 'dist/cli.js');
const liveRunDist = join(liveDir, 'dist/run.js');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const realFirebaseDir = realpathSync(dirname(requireFromRepo.resolve('firebase/package.json')));

describe('parseLiveRunInvocation', () => {
  test('runs the command after -- against the loopback host --host names', () => {
    expect(
      parseLiveRunInvocation(['--host', 'remote:http://localhost:5173/', '--', 'node', 'dist/index.js', '--port', '1'], {}),
    ).toEqual({
      kind: 'run',
      hostUrl: 'http://localhost:5173',
      plan: { argv: ['node', 'dist/index.js', '--port', '1'], label: 'node dist/index.js --port 1' },
      waitMs: 0,
    });
  });

  test('accepts IPv4 and IPv6 loopback origins for --host and --host=...', () => {
    expect(parseLiveRunInvocation(['--host=http://127.0.0.1:3473', '--', 'node', 'a.js'], {})).toMatchObject({
      kind: 'run',
      hostUrl: 'http://127.0.0.1:3473',
    });
    expect(parseLiveRunInvocation(['--host=http://[::1]:3473', '--', 'node', 'a.js'], {})).toMatchObject({
      kind: 'run',
      hostUrl: 'http://[::1]:3473',
    });
  });

  test('falls back to an inherited loopback PYRIC_SANDBOX=remote:<url>', () => {
    const res = parseLiveRunInvocation(['--', 'node', 'a.js'], { PYRIC_SANDBOX: 'remote:http://localhost:5173' });
    expect(res).toMatchObject({ kind: 'run', hostUrl: 'http://localhost:5173' });
  });

  test('leaves the host to discovery when nothing names a URL', () => {
    const res = parseLiveRunInvocation(['--', 'node', 'a.js'], { PYRIC_SANDBOX: 'remote' });
    expect(res).toMatchObject({ kind: 'run', hostUrl: null });
  });

  test('prefers --host over an inherited PYRIC_SANDBOX URL', () => {
    const res = parseLiveRunInvocation(['--host', 'http://localhost:3473', '--', 'node', 'a.js'], {
      PYRIC_SANDBOX: 'remote:http://localhost:5173',
    });
    expect(res).toMatchObject({ kind: 'run', hostUrl: 'http://localhost:3473' });
  });

  test('recognizes --help and -h before --, while preserving --help after -- for the child command', () => {
    expect(parseLiveRunInvocation(['--help'], {})).toEqual({ kind: 'help' });
    expect(parseLiveRunInvocation(['-h'], {})).toEqual({ kind: 'help' });
    const childHelp = parseLiveRunInvocation(['--', 'node', 'server.js', '--help'], {});
    expect(childHelp).toMatchObject({
      kind: 'run',
      plan: { argv: ['node', 'server.js', '--help'], label: 'node server.js --help' },
    });
  });

  test('refuses a missing command or leading env assignments without a command', () => {
    for (const argv of [['--host', 'http://localhost:3473'], ['--', 'PORT=8080']]) {
      const res = parseLiveRunInvocation(argv, {});
      expect(res).toEqual({
        kind: 'error',
        message: `pyric-live run: no command to run.\n${LIVE_RUN_USAGE}`,
      });
    }
  });

  test('refuses missing, malformed, credentialed, or path-carrying --host URLs (exit 1)', () => {
    for (const argv of [
      ['--host', '--', 'node', 'a.js'],
      ['--host', 'localhost:5173', '--', 'node', 'a.js'],
      ['--host', 'http://', '--', 'node', 'a.js'],
      ['--host', 'http://[invalid', '--', 'node', 'a.js'],
      ['--host', 'http://localhost:5173/app', '--', 'node', 'a.js'],
      ['--host', 'http://user:secret@localhost:5173', '--', 'node', 'a.js'],
    ]) {
      const res = parseLiveRunInvocation(argv, {});
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.message).toMatch(/^pyric-live run: --host needs a host URL/);
      }
    }
  });

  test('refuses non-loopback --host and non-loopback PYRIC_SANDBOX=remote:<url> (ADR 0024)', () => {
    for (const remoteUrl of ['http://example.com:5173', 'https://192.168.1.10:3473']) {
      const flagRes = parseLiveRunInvocation(['--host', remoteUrl, '--', 'node', 'a.js'], {});
      expect(flagRes.kind).toBe('error');
      if (flagRes.kind === 'error') {
        expect(flagRes.message).toContain('loopback URLs only');
      }

      const envRes = parseLiveRunInvocation(['--', 'node', 'a.js'], { PYRIC_SANDBOX: `remote:${remoteUrl}` });
      expect(envRes.kind).toBe('error');
      if (envRes.kind === 'error') {
        expect(envRes.message).toContain('loopback URL');
      }
    }
  });

  test('waits the default 30s bound for a bare --wait and accepts positive finite seconds', () => {
    const bare = parseLiveRunInvocation(['--wait', '--', 'node', 'a.js'], {});
    expect(bare).toMatchObject({ kind: 'run', waitMs: DEFAULT_WAIT_SECONDS * 1000 });

    for (const flags of [['--wait=12.5'], ['--wait', '12.5']]) {
      const explicit = parseLiveRunInvocation([...flags, '--', 'node', 'a.js'], {});
      expect(explicit).toMatchObject({ kind: 'run', waitMs: 12_500 });
    }
  });

  test('refuses a --wait that is not a positive finite number of seconds', () => {
    for (const value of ['soon', '0', '-5', 'NaN', 'Infinity']) {
      const res = parseLiveRunInvocation([`--wait=${value}`, '--', 'node', 'a.js'], {});
      expect(res.kind).toBe('error');
      if (res.kind === 'error') {
        expect(res.message).toMatch(/^pyric-live run: --wait takes a number of seconds/);
      }
    }
  });

  test('refuses unknown options before --', () => {
    const res = parseLiveRunInvocation(['--sandbox', 'http://localhost:5173', '--', 'node', 'a.js'], {});
    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.message).toContain('--sandbox');
      expect(res.message).toContain('--host');
    }
  });
});

describe('buildLiveChildEnv', () => {
  test('prepends --import <registerFileUrl> to NODE_OPTIONS without activating @pyric/cli/register and sets host env', () => {
    const registerUrl = liveRegisterModuleUrl();
    expect(registerUrl).toMatch(/^file:\/\/\/.+\/dist\/register\.js$/);

    const env = buildLiveChildEnv(
      {
        PATH: '/usr/bin',
        NODE_OPTIONS: '--max-old-space-size=4096',
        PYRIC_SANDBOX_INSTANCE: 'stale-instance',
        PYRIC_SESSION_TOKEN: 'stale-token',
      },
      {
        serveUrl: 'http://localhost:3473',
        registerUrl,
        projectId: 'acme-live',
        instanceId: 'live-instance-1',
        sessionToken: 'live-token-1',
      },
    );

    expect(env.NODE_OPTIONS).toBe(`--import ${registerUrl} --max-old-space-size=4096`);
    expect(env.NODE_OPTIONS).not.toContain('@pyric/cli/register');
    expect(env.PYRIC_SANDBOX).toBe('remote:http://localhost:3473');
    expect(env.PYRIC_SANDBOX_INSTANCE).toBe('live-instance-1');
    expect(env.PYRIC_SESSION_TOKEN).toBe('live-token-1');
    expect(env.PYRIC_PROJECT).toBe('acme-live');
  });

  test('preserves an explicit PYRIC_PROJECT in base env and strips stale instance/token when omitted', () => {
    const registerUrl = liveRegisterModuleUrl();
    const env = buildLiveChildEnv(
      {
        PYRIC_PROJECT: 'explicit-project',
        PYRIC_SANDBOX_INSTANCE: 'stale-instance',
        PYRIC_SESSION_TOKEN: 'stale-token',
      },
      {
        serveUrl: 'http://127.0.0.1:3473',
        registerUrl,
        projectId: 'acme-live',
      },
    );
    expect(env.PYRIC_PROJECT).toBe('explicit-project');
    expect(env.PYRIC_SANDBOX_INSTANCE).toBeUndefined();
    expect(env.PYRIC_SESSION_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBe(`--import ${registerUrl}`);
  });
});

describe('actionable refusal messages', () => {
  test('notALiveHostMessage, sandboxHostRefusalMessage, and tokenGatedHostMessage name npx pyric-live and pyricLive()', () => {
    for (const isVite of [true, false]) {
      const msg = notALiveHostMessage('http://localhost:5173', isVite, 'vite.config.mts');
      expect(msg).toContain('pyricLive()');
      expect(msg).toContain('vite.config.mts');
    }
    expect(notALiveHostMessage('http://localhost:5173', false, 'vite.config.ts')).toContain('npx pyric-live');
    const sandboxMsg = sandboxHostRefusalMessage('http://localhost:5173', 'vite.config.ts');
    expect(sandboxMsg).toContain('sandbox host');
    expect(sandboxMsg).toContain('npx pyric-live');
    expect(sandboxMsg).toContain('pyricLive()');
    const gatedMsg = tokenGatedHostMessage('http://localhost:5173', '/repo/app');
    expect(gatedMsg).toContain('session token');
    expect(gatedMsg).toContain('npx pyric-live');
    expect(gatedMsg).toContain('pyricLive()');
  });
});

describe('pyric-live --help and pyric-live run --help / unsupported runtime', () => {
  test('includes pyric-live run in pyric-live --help and supports pyric-live run --help', () => {
    const topHelp = spawnSync('node', [liveCliDist, '--help'], { encoding: 'utf8' });
    expect(topHelp.status).toBe(0);
    expect(topHelp.stdout).toContain('Usage: pyric-live [options]');
    expect(topHelp.stdout).toContain('pyric-live run');

    for (const flag of ['--help', '-h']) {
      const runHelp = spawnSync('node', [liveCliDist, 'run', flag], { encoding: 'utf8' });
      expect(runHelp.status).toBe(0);
      expect(runHelp.stdout).toContain('pyric-live run [--host <url>] [--wait[=<seconds>]] -- <command> [args...]');
      expect(runHelp.stdout).toContain('pyricLive()');
    }
  }, 30_000);

  test('stops upfront with PYRIC_UNSUPPORTED_RUNTIME (exit 1) before polling --host for bun, bunx, and deno', () => {
    for (const [cmd, expectedRuntime] of [
      [['bun', 'run', 'server.ts'], 'bun'],
      [['bunx', 'tsx', 'server.ts'], 'bun'],
      [['deno', 'run', 'server.ts'], 'deno'],
    ] as const) {
      const started = Date.now();
      const res = spawnSync(
        'node',
        [liveCliDist, 'run', '--host', 'http://127.0.0.1:9', '--wait=30', '--', ...cmd],
        { encoding: 'utf8' },
      );
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('pyric-live run: stopped before starting');
      expect(res.stderr).toContain('PYRIC_UNSUPPORTED_RUNTIME');
      expect(res.stderr).toContain(`\`${expectedRuntime}\``);
      expect(res.stderr).toContain('Node >= 22.15');
      expect(Date.now() - started).toBeLessThan(3_000);
    }
  }, 30_000);

  test('stops upfront with exit 1 when Node lacks module.registerHooks (Node < 22.15)', async () => {
    let errText = '';
    const unitCode = await runLiveRun(['--host', 'http://127.0.0.1:9', '--', 'node', '-e', '0'], {
      stderr: (t) => {
        errText += t;
      },
      hasRegisterHooks: () => false,
    });
    expect(unitCode).toBe(1);
    expect(errText).toContain('module.registerHooks, in Node 22.15 or later');

    const sub = spawnSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import Module from 'node:module';
delete Module.registerHooks;
const { runLiveRun } = await import(${JSON.stringify(pathToFileURL(liveRunDist).href)});
process.exit(await runLiveRun(['--host', 'http://127.0.0.1:9', '--', 'node', '-e', '0']));`,
      ],
      { encoding: 'utf8' },
    );
    expect(sub.status).toBe(1);
    expect(sub.stderr).toContain('module.registerHooks, in Node 22.15 or later');
  });
});

describe('pyric-live run host probing, waiting, refusals, and end-to-end child execution', () => {
  const servers: Server[] = [];
  const netServers: NetServer[] = [];
  const tempDirs: string[] = [];
  const childProcesses: ChildProcess[] = [];

  afterEach(async () => {
    for (const proc of childProcesses.splice(0)) {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
      }
    }
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
    await Promise.all(netServers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
  }

  async function freeLoopbackPort(): Promise<number> {
    const srv = createNetServer();
    await new Promise<void>((done) => srv.listen(0, '127.0.0.1', () => done()));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((done) => srv.close(() => done()));
    return port;
  }

  function createEmptyProjectsWorkspace(): string {
    const dir = freshDir('pyric-live-run-ws-');
    mkdirSync(join(dir, 'node_modules/@pyric'), { recursive: true });
    symlinkSync(cliDir, join(dir, 'node_modules/@pyric/cli'));
    symlinkSync(liveDir, join(dir, 'node_modules/@pyric/live'));
    symlinkSync(realFirebaseDir, join(dir, 'node_modules/firebase'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'acme-app', type: 'module' }));
    writeFileSync(
      join(dir, '.firebaserc'),
      JSON.stringify({
        projects: {},
        targets: { 'acme-live': { hosting: { web: ['acme-site'] } } },
      }),
    );
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(join(dir, 'public/index.html'), '<!doctype html><title>acme</title>');
    return dir;
  }

  function writeServePointer(
    dir: string,
    info: { port: number; url?: string; instanceId?: string; token?: string; pid?: number },
  ): void {
    mkdirSync(join(dir, '.pyric'), { recursive: true });
    writeFileSync(
      join(dir, '.pyric/serve.json'),
      JSON.stringify({
        port: info.port,
        url: info.url ?? `http://localhost:${info.port}`,
        mcpUrl: `http://127.0.0.1:${info.port}/__pyric/mcp`,
        pid: info.pid ?? process.pid,
        instanceId: info.instanceId ?? 'live-run-instance',
        ...(info.token ? { token: info.token } : {}),
      }),
      { mode: 0o600 },
    );
  }

  function startMockLiveHost(options: { instanceId: string; token: string; projectId?: string }): Promise<{
    port: number;
    url: string;
  }> {
    const projectId = options.projectId ?? 'acme-live';
    const server = createServer((req, res) => {
      if (req.url === '/__pyric/health') {
        const authed = req.headers['x-pyric-session-token'] === options.token;
        res.writeHead(200, { 'content-type': 'application/json' });
        if (authed) {
          res.end(
            JSON.stringify({
              status: 'ok',
              mode: 'sandbox',
              project: projectId,
              version: '0.1.0',
              startedAt: '2026-01-01T00:00:00.000Z',
              instanceId: options.instanceId,
              sandboxConnected: true,
              live: {
                projectId,
                configProjectId: projectId,
                configSource: 'option',
                appProjectIds: [],
                billed: { reads: 0, writes: 0, deliveries: 0 },
              },
            }),
          );
        } else {
          res.end(
            JSON.stringify({
              status: 'ok',
              mode: 'sandbox',
              instanceId: options.instanceId,
              sandboxConnected: true,
            }),
          );
        }
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(server);
    return new Promise((done) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        done({ port, url: `http://127.0.0.1:${port}` });
      });
    });
  }

  async function invokeRun(argv: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{
    code: number;
    stdout: string;
    stderr: string;
    ms: number;
  }> {
    let stdout = '';
    let stderr = '';
    const started = Date.now();
    const code = await runLiveRun(argv, {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, ...env },
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { code, stdout, stderr, ms: Date.now() - started };
  }

  test('refuses sandbox hosts immediately (both sandboxConnected true and false, without local token) without waiting out --wait', async () => {
    for (const sandboxConnected of [true, false]) {
      const dir = createEmptyProjectsWorkspace();
      const server = createServer((req, res) => {
        if (req.url === '/__pyric/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              mode: 'sandbox',
              project: 'sandbox',
              version: '0.1.0',
              startedAt: '2026-01-01T00:00:00.000Z',
              instanceId: 'sbx-1',
              sandboxConnected,
            }),
          );
          return;
        }
        res.writeHead(404).end();
      });
      servers.push(server);
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
      const port = (server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}`;

      const explicit = await invokeRun(['--host', url, '--wait=5', '--', 'node', '-e', '0'], dir);
      expect(explicit.code).toBe(2);
      expect(explicit.stderr).toContain(`the host at ${url} is a sandbox host, not a live host`);
      expect(explicit.stderr).toContain('npx pyric-live');
      expect(explicit.stderr).toContain('pyricLive()');
      expect(explicit.ms).toBeLessThan(2_000);

      writeServePointer(dir, { port, instanceId: 'sbx-1' });
      const discovered = await invokeRun(['--wait=5', '--', 'node', '-e', '0'], dir);
      expect(discovered.code).toBe(2);
      expect(discovered.stderr).toContain(`the host at http://localhost:${port} is a sandbox host, not a live host`);
      expect(discovered.stderr).toContain('npx pyric-live');
      expect(discovered.stderr).toContain('pyricLive()');
      expect(discovered.ms).toBeLessThan(2_000);
    }
  });

  test('refuses a plain HTTP server and a Vite server without pyricLive() immediately (exit 2)', async () => {
    const dir = createEmptyProjectsWorkspace();
    writeFileSync(join(dir, 'vite.config.mts'), 'export default {};\n');

    const servePaths = async (paths: string[]): Promise<string> => {
      const server = createServer((req, res) => {
        if (paths.includes(req.url ?? '')) {
          res.writeHead(200, { 'content-type': 'text/javascript' }).end('export {}');
          return;
        }
        res.writeHead(404).end();
      });
      servers.push(server);
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };

    const viteUrl = await servePaths(['/@vite/env']);
    const viteRes = await invokeRun(['--host', viteUrl, '--wait=5', '--', 'node', '-e', '0'], dir);
    expect(viteRes.code).toBe(2);
    expect(viteRes.stderr).toContain(`reached a Vite server without a pyric live host at ${viteUrl}`);
    expect(viteRes.stderr).toContain('pyricLive() from @pyric/live/vite in vite.config.mts');
    expect(viteRes.ms).toBeLessThan(2_000);

    const httpUrl = await servePaths([]);
    const httpRes = await invokeRun(['--host', httpUrl, '--wait=5', '--', 'node', '-e', '0'], dir);
    expect(httpRes.code).toBe(2);
    expect(httpRes.stderr).toContain(`${httpUrl} answers, but it is not a pyric live host`);
    expect(httpRes.stderr).toContain('npx pyric-live');
    expect(httpRes.stderr).toContain('pyricLive() from @pyric/live/vite in vite.config.mts');
    expect(httpRes.ms).toBeLessThan(2_000);
  });

  test('exits 2 on unreachable --host or unanswered .pyric/serve.json without 10s pointer wait when --wait is omitted', async () => {
    const dir = createEmptyProjectsWorkspace();
    const closedPort = await freeLoopbackPort();
    const closedUrl = `http://127.0.0.1:${closedPort}`;

    const immediateHost = await invokeRun(['--host', closedUrl, '--', 'node', '-e', '0'], dir);
    expect(immediateHost.code).toBe(2);
    expect(immediateHost.stderr).toContain(`no live host answers at ${closedUrl}/__pyric/health.`);
    expect(immediateHost.ms).toBeLessThan(2_000);

    const timedOutHost = await invokeRun(['--host', closedUrl, '--wait=0.5', '--', 'node', '-e', '0'], dir);
    expect(timedOutHost.code).toBe(2);
    expect(timedOutHost.stderr).toContain(`no live host answers at ${closedUrl}/__pyric/health after waiting 0.5s.`);
    expect(timedOutHost.ms).toBeGreaterThanOrEqual(450);

    // Even when .pyric/serve.json names a live PID on an unanswered port, omitting --wait probes once.
    writeServePointer(dir, { port: closedPort, instanceId: 'dead-listener', pid: process.pid });
    const immediateDiscovery = await invokeRun(['--', 'node', '-e', '0'], dir);
    expect(immediateDiscovery.code).toBe(2);
    expect(immediateDiscovery.stderr).toContain('no running live host found; start one with npx pyric-live or pyricLive()');
    expect(immediateDiscovery.ms).toBeLessThan(2_000);

    const timedOutDiscovery = await invokeRun(['--wait=0.5', '--', 'node', '-e', '0'], dir);
    expect(timedOutDiscovery.code).toBe(2);
    expect(timedOutDiscovery.stderr).toContain('no running live host found after waiting 0.5s');
    expect(timedOutDiscovery.ms).toBeGreaterThanOrEqual(450);
    expect(timedOutDiscovery.ms).toBeLessThan(3_000);
  });

  test('refuses token-gated live hosts outside the pointer tree and unowned spoofed live JSON without blessing PYRIC_SANDBOX_INSTANCE', async () => {
    const projectDir = createEmptyProjectsWorkspace();
    const externalDir = freshDir('pyric-live-outside-');
    const host = await startMockLiveHost({ instanceId: 'owned-live-1', token: 'owned-token-1' });
    writeServePointer(projectDir, { port: host.port, instanceId: 'owned-live-1', token: 'owned-token-1' });

    // Without PYRIC_SESSION_TOKEN or reachable .pyric/serve.json, reports session-token refusal (NOT "sandbox host").
    const outsideNoWait = await invokeRun(['--host', host.url, '--', 'node', '-e', '0'], externalDir);
    expect(outsideNoWait.code).toBe(2);
    expect(outsideNoWait.stderr).toContain('requires a session token');
    expect(outsideNoWait.stderr).not.toContain('is a sandbox host');
    expect(outsideNoWait.ms).toBeLessThan(2_000);

    const outsideWithWait = await invokeRun(['--host', host.url, '--wait=0.4', '--', 'node', '-e', '0'], externalDir);
    expect(outsideWithWait.code).toBe(2);
    expect(outsideWithWait.stderr).toContain('requires a session token');
    expect(outsideWithWait.stderr).not.toContain('no live host answers');

    // Unowned spoofed loopback server returning `live` when caller holds NO session token for that port is refused.
    const spoofServer = createServer((req, res) => {
      if (req.url === '/__pyric/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            mode: 'sandbox',
            version: '0.1.0',
            instanceId: 'spoofed-instance',
            sandboxConnected: true,
            live: {
              projectId: 'acme-live',
              configProjectId: 'acme-live',
              configSource: 'option',
              appProjectIds: [],
              billed: { reads: 0, writes: 0, deliveries: 0 },
            },
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(spoofServer);
    await new Promise<void>((done) => spoofServer.listen(0, '127.0.0.1', () => done()));
    const spoofUrl = `http://127.0.0.1:${(spoofServer.address() as AddressInfo).port}`;

    const spoofRes = await invokeRun(['--host', spoofUrl, '--', 'node', '-e', '0'], projectDir);
    expect(spoofRes.code).toBe(2);
    expect(spoofRes.stderr).toContain('requires a session token');
  });

  test('polls with --wait until a delayed, token-gated live host writes .pyric/serve.json (covering both sandboxConnected false and true windows)', async () => {
    const dir = createEmptyProjectsWorkspace();
    const port = await freeLoopbackPort();
    const url = `http://127.0.0.1:${port}`;
    const secretToken = 'cap-token-live-wait';
    let sandboxConnected = false;

    const server = createServer((req, res) => {
      if (req.url === '/__pyric/health') {
        const authed = req.headers['x-pyric-session-token'] === secretToken;
        res.writeHead(200, { 'content-type': 'application/json' });
        if (sandboxConnected && authed) {
          res.end(
            JSON.stringify({
              status: 'ok',
              mode: 'sandbox',
              version: '0.1.0',
              instanceId: 'delayed-live-id',
              sandboxConnected: true,
              live: {
                projectId: 'acme-live',
                configProjectId: 'acme-live',
                configSource: 'option',
                appProjectIds: [],
                billed: { reads: 0, writes: 0, deliveries: 0 },
              },
            }),
          );
        } else {
          // Unauthenticated stripped health both while `sandboxConnected` is false AND during `settleHeldPointer` (`sandboxConnected: true`).
          res.end(
            JSON.stringify({
              status: 'ok',
              mode: 'sandbox',
              instanceId: 'delayed-live-id',
              sandboxConnected,
            }),
          );
        }
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(server);

    setTimeout(() => {
      server.listen(port, '127.0.0.1', () => {
        setTimeout(() => {
          sandboxConnected = true;
          setTimeout(() => {
            writeServePointer(dir, { port, instanceId: 'delayed-live-id', token: secretToken });
          }, 200);
        }, 200);
      });
    }, 250);

    const outFile = join(dir, 'wait-explicit.json');
    const explicit = await invokeRun(
      [
        '--host',
        url,
        '--wait=5',
        '--',
        'node',
        '-e',
        `import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ project: process.env.PYRIC_PROJECT, token: process.env.PYRIC_SESSION_TOKEN })))`,
      ],
      dir,
    );
    expect(explicit.code, explicit.stderr).toBe(0);
    expect(JSON.parse(readFileSync(outFile, 'utf8'))).toEqual({ project: 'acme-live', token: secretToken });

    rmSync(join(dir, '.pyric'), { recursive: true, force: true });
    setTimeout(() => {
      writeServePointer(dir, { port, instanceId: 'delayed-live-id', token: secretToken });
    }, 300);

    const outDiscovered = join(dir, 'wait-discovered.json');
    const discovered = await invokeRun(
      [
        '--wait=5',
        '--',
        'node',
        '-e',
        `import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(outDiscovered)}, JSON.stringify({ project: process.env.PYRIC_PROJECT })))`,
      ],
      dir,
    );
    expect(discovered.code, discovered.stderr).toBe(0);
    expect(JSON.parse(readFileSync(outDiscovered, 'utf8'))).toEqual({ project: 'acme-live' });
  }, 20_000);

  test('spawns a node child end-to-end across discovery, monorepo apps/web -> services/api, inline NODE_OPTIONS, and exit codes', async () => {
    const dir = createEmptyProjectsWorkspace();
    const appsWebDir = join(dir, 'apps/web');
    const servicesApiDir = join(dir, 'services/api');
    mkdirSync(appsWebDir, { recursive: true });
    mkdirSync(servicesApiDir, { recursive: true });

    const sink = createNetServer((socket) => socket.destroy());
    netServers.push(sink);
    await new Promise<void>((done) => sink.listen(0, '127.0.0.1', () => done()));
    const sinkPort = (sink.address() as AddressInfo).port;

    const secretToken = 'e2e-live-token';
    const host = await startMockLiveHost({ instanceId: 'e2e-live-host', token: secretToken, projectId: 'acme-live' });
    writeServePointer(dir, { port: host.port, instanceId: 'e2e-live-host', token: secretToken });

    const childScript = join(servicesApiDir, 'job.mjs');
    writeFileSync(
      childScript,
      `import { initializeApp } from 'firebase/app';
import { doc, getDocFromCache, initializeFirestore } from 'firebase/firestore';

const settings = { host: '127.0.0.1:${sinkPort}', ssl: false };
const hostDb = initializeFirestore(initializeApp({ projectId: 'acme-live', apiKey: 'k', appId: '1:1:web:1' }, 'host'), settings);
const otherDb = initializeFirestore(initializeApp({ projectId: 'other-project', apiKey: 'k', appId: '1:1:web:1' }, 'other'), settings);

const codeOf = async (fn) => {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return err?.code ?? String(err);
  }
};

const hostCall = await codeOf(() => getDocFromCache(doc(hostDb, 'items/1')));
const otherCall = await codeOf(() => getDocFromCache(doc(otherDb, 'items/1')));
console.log(JSON.stringify({
  pyricProject: process.env.PYRIC_PROJECT,
  gcloudProject: process.env.GOOGLE_CLOUD_PROJECT,
  nodeOptions: process.env.NODE_OPTIONS ?? '',
  nodeOptionsHasCliRegister: (process.env.NODE_OPTIONS ?? '').includes('@pyric/cli/register'),
  hostCall,
  otherCall,
}));
process.exit(Number(process.env.EXIT_WITH ?? '0'));
`,
    );

    const spawnCli = (args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
        const proc = spawn('node', [liveCliDist, ...args], {
          cwd,
          env: { PATH: process.env.PATH, HOME: cwd, ...extraEnv },
        });
        childProcesses.push(proc);
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (c: Buffer) => {
          stdout += c.toString();
        });
        proc.stderr?.on('data', (c: Buffer) => {
          stderr += c.toString();
        });
        proc.once('exit', (status) => done({ status, stdout, stderr }));
      });

    // 1. Discovery from project root (exits 0, raw JSON line on stdout with no [dev] prefix).
    const discoveredRun = await spawnCli(['run', '--', 'node', childScript], dir);
    expect(discoveredRun.status, discoveredRun.stderr).toBe(0);
    const parsedDiscovered = JSON.parse(discoveredRun.stdout.trim()) as Record<string, unknown>;
    expect(parsedDiscovered).toMatchObject({
      pyricProject: 'acme-live',
      gcloudProject: 'acme-live',
      nodeOptionsHasCliRegister: false,
      otherCall: 'PYRIC_LIVE_REFUSED',
    });
    expect(parsedDiscovered.hostCall).not.toBe('PYRIC_LIVE_REFUSED');
    expect(discoveredRun.stderr).toContain('@pyric/live/register: live mode for the Firebase project acme-live.');

    // 2. Monorepo sibling lookup: pointer lives only in `apps/web/.pyric/serve.json`, invoked from `services/api`
    //    with inline `NODE_OPTIONS=--max-old-space-size=4096` and `EXIT_WITH=42`.
    rmSync(join(dir, '.pyric'), { recursive: true, force: true });
    writeServePointer(appsWebDir, { port: host.port, instanceId: 'e2e-live-host', token: secretToken });

    const siblingRun = await spawnCli(
      ['run', '--host', host.url, '--', 'NODE_OPTIONS=--max-old-space-size=4096', 'EXIT_WITH=42', 'node', childScript],
      servicesApiDir,
    );
    expect(siblingRun.status, siblingRun.stderr).toBe(42);
    const parsedSibling = JSON.parse(siblingRun.stdout.trim()) as Record<string, unknown>;
    expect(parsedSibling).toMatchObject({
      pyricProject: 'acme-live',
      gcloudProject: 'acme-live',
      otherCall: 'PYRIC_LIVE_REFUSED',
    });
    expect(String(parsedSibling.nodeOptions)).toContain('--max-old-space-size=4096');
    expect(String(parsedSibling.nodeOptions)).toContain('/dist/register.js');
    expect(siblingRun.stderr).toContain('@pyric/live/register: live mode for the Firebase project acme-live.');

    // 3. External directory outside pointer tree WITH explicit PYRIC_SESSION_TOKEN.
    const externalDir = freshDir('pyric-live-run-ext-');
    const explicitRun = await spawnCli(
      ['run', '--host', host.url, '--', 'EXIT_WITH=7', 'node', childScript],
      externalDir,
      { PYRIC_SESSION_TOKEN: secretToken },
    );
    expect(explicitRun.status, explicitRun.stderr).toBe(7);
    const parsedExplicit = JSON.parse(explicitRun.stdout.trim()) as Record<string, unknown>;
    expect(parsedExplicit).toMatchObject({
      pyricProject: 'acme-live',
      gcloudProject: 'acme-live',
      otherCall: 'PYRIC_LIVE_REFUSED',
    });
  }, 30_000);

  test('forwards both SIGTERM and SIGINT from pyric-live run to the spawned child process', async () => {
    const dir = createEmptyProjectsWorkspace();
    const secretToken = 'sig-live-token';
    const host = await startMockLiveHost({ instanceId: 'sig-live-host', token: secretToken });
    writeServePointer(dir, { port: host.port, instanceId: 'sig-live-host', token: secretToken });

    for (const [sig, expectedExit] of [
      ['SIGTERM', 143],
      ['SIGINT', 130],
    ] as const) {
      const sigScript = join(dir, `wait-${sig}.mjs`);
      writeFileSync(
        sigScript,
        `process.on(${JSON.stringify(sig)}, () => {
  console.log('CHILD_GOT_' + ${JSON.stringify(sig)});
  process.exit(${expectedExit});
});
console.log('CHILD_READY');
setInterval(() => {}, 1000);
`,
      );

      const runner = spawn('node', [liveCliDist, 'run', '--host', host.url, '--', 'node', sigScript], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir },
      });
      childProcesses.push(runner);
      let stdout = '';
      runner.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error(`timed out waiting for CHILD_READY: ${stdout}`)), 15_000);
        runner.stdout?.on('data', () => {
          if (stdout.includes('CHILD_READY')) {
            clearTimeout(timer);
            resolveReady();
          }
        });
        runner.once('exit', (code) => {
          clearTimeout(timer);
          rejectReady(new Error(`runner exited early (${code}): ${stdout}`));
        });
      });

      runner.kill(sig);
      const exitCode = await new Promise<number | null>((done) => runner.once('exit', (code) => done(code)));
      expect(stdout).toContain(`CHILD_GOT_${sig}`);
      expect(exitCode).toBe(expectedExit);
    }
  }, 30_000);

  test('keeps pyric-live [options] host mode unchanged and attaches pyric-live run --wait to a real pyric-live --project host', async () => {
    const dir = createEmptyProjectsWorkspace();
    const port = await freeLoopbackPort();
    const hostUrl = `http://127.0.0.1:${port}`;

    const sink = createNetServer((socket) => socket.destroy());
    netServers.push(sink);
    await new Promise<void>((done) => sink.listen(0, '127.0.0.1', () => done()));
    const sinkPort = (sink.address() as AddressInfo).port;

    const hostProc = spawn(
      'node',
      [liveCliDist, '--no-open', '--host', '127.0.0.1', '--port', String(port), '--project', 'acme-live'],
      { cwd: dir, env: { PATH: process.env.PATH, HOME: dir } },
    );
    childProcesses.push(hostProc);
    let hostOut = '';
    hostProc.stdout?.on('data', (c: Buffer) => {
      hostOut += c.toString();
    });
    hostProc.stderr?.on('data', (c: Buffer) => {
      hostOut += c.toString();
    });

    const script = join(dir, 'against-real-host.mjs');
    writeFileSync(
      script,
      `import { initializeApp } from 'firebase/app';
import { doc, getDocFromCache, initializeFirestore } from 'firebase/firestore';
const settings = { host: '127.0.0.1:${sinkPort}', ssl: false };
const hostDb = initializeFirestore(initializeApp({ projectId: 'acme-live', apiKey: 'k', appId: '1:1:web:1' }, 'host'), settings);
const otherDb = initializeFirestore(initializeApp({ projectId: 'other-project', apiKey: 'k', appId: '1:1:web:1' }, 'other'), settings);
const codeOf = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e?.code ?? String(e); } };
const hostCall = await codeOf(() => getDocFromCache(doc(hostDb, 'items/1')));
const otherCall = await codeOf(() => getDocFromCache(doc(otherDb, 'items/1')));
console.log('REAL_HOST_OUTCOME ' + JSON.stringify({ project: process.env.PYRIC_PROJECT, hostCall, otherCall }));
process.exit(0);
`,
    );

    const runner = spawn('node', [liveCliDist, 'run', '--host', hostUrl, '--wait=30', '--', 'node', script], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir },
    });
    childProcesses.push(runner);
    let runOut = '';
    let runErr = '';
    runner.stdout?.on('data', (c: Buffer) => {
      runOut += c.toString();
    });
    runner.stderr?.on('data', (c: Buffer) => {
      runErr += c.toString();
    });

    const runCode = await new Promise<number | null>((done) => runner.once('exit', (code) => done(code)));
    hostProc.kill('SIGTERM');
    await new Promise<void>((done) => hostProc.once('exit', () => done()));

    expect(runCode, `runErr:\n${runErr}\nhostOut:\n${hostOut}`).toBe(0);
    expect(hostOut).toContain('pyric-live: live mode for the Firebase project acme-live.');
    expect(runErr).toContain('@pyric/live/register: live mode for the Firebase project acme-live.');
    expect(runErr).toContain(`@pyric/live/register: reporting calls to the live host at ${hostUrl}.`);
    const line = runOut.split('\n').find((l) => l.startsWith('REAL_HOST_OUTCOME '));
    expect(line).toBeDefined();
    const outcome = JSON.parse(line!.slice('REAL_HOST_OUTCOME '.length)) as Record<string, string>;
    expect(outcome.project).toBe('acme-live');
    expect(outcome.hostCall).not.toBe('PYRIC_LIVE_REFUSED');
    expect(outcome.otherCall).toBe('PYRIC_LIVE_REFUSED');
  }, 60_000);
});
