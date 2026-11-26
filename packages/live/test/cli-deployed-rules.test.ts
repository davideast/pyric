/**
 * Opt-in `--deployed-rules` (`pyric-live`) and `deployedRules` (`pyricLive()`):
 * verifies strictly off-by-default behavior, flag/option validation, `--help`
 * documentation, and credential-free `/__pyric/health` reporting (#2363).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseLiveHostArgs } from '../src/host-args.js';
import { pyricLive } from '../src/vite.js';

const liveDir = resolve(import.meta.dir, '..');
const repoRoot = resolve(liveDir, '../..');
const cliDir = join(repoRoot, 'packages/cli');
const liveCliDist = join(liveDir, 'dist/cli.js');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const realFirebaseDir = realpathSync(dirname(requireFromRepo.resolve('firebase/package.json')));
const { freePort: freeLoopbackPort } = (await import(
  new URL('../../../test/apps/ports.ts', import.meta.url).href
)) as {
  freePort: () => Promise<number>;
};

const tempDirs: string[] = [];
const spawned: ChildProcess[] = [];

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-live-deployed-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-deployed-live' } }));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' } }));
  writeFileSync(
    join(dir, 'firestore.rules'),
    "rules_version = '2';\nservice cloud.firestore { match /databases/{database}/documents { match /{doc=**} { allow read: if false; } } }\n",
  );
  const scopeDir = join(dir, 'node_modules', '@pyric');
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(liveDir, join(scopeDir, 'live'));
  symlinkSync(cliDir, join(scopeDir, 'cli'));
  symlinkSync(realFirebaseDir, join(dir, 'node_modules', 'firebase'));
  return dir;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timer);
      done();
    });
  });
}

afterEach(async () => {
  while (spawned.length > 0) {
    const child = spawned.pop();
    if (child !== undefined) await stopChild(child);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

async function waitForHealth(
  projectDir: string,
  port: number,
  child: ChildProcess,
  output: () => string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pointerFile = join(projectDir, '.pyric', 'serve.json');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`pyric-live exited early (${child.exitCode}):\n${output()}`);
    }
    if (existsSync(pointerFile)) {
      try {
        const pointer = JSON.parse(readFileSync(pointerFile, 'utf8')) as { port?: number; token?: string };
        if (pointer.port === port && typeof pointer.token === 'string' && pointer.token.length > 0) {
          const res = await fetch(`http://127.0.0.1:${port}/__pyric/health`, {
            headers: { 'x-pyric-session-token': pointer.token },
          });
          if (res.status === 200) {
            const body = (await res.json()) as Record<string, unknown>;
            if (body.live !== undefined && body.sandboxConnected !== false) {
              return { status: res.status, body };
            }
          }
        }
      } catch (_error: unknown) {
        // Host still booting.
      }
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`Timed out waiting for pyric-live health on port ${port}:\n${output()}`);
}

describe('parseLiveHostArgs --deployed-rules', () => {
  test('is strictly false by default and enables opt-in only when --deployed-rules is passed', () => {
    const off = parseLiveHostArgs(['--port', '3473']);
    expect(off).toEqual({
      kind: 'start',
      allowRemotePeers: false,
      deployedRules: false,
      passThrough: [],
      hostArgv: ['--port', '3473'],
    });

    const on = parseLiveHostArgs(['--deployed-rules', '--pass-through', 'firebase/functions', '--no-open']);
    expect(on).toEqual({
      kind: 'start',
      allowRemotePeers: false,
      deployedRules: true,
      passThrough: ['firebase/functions'],
      hostArgv: ['--no-open'],
    });

    const afterSeparator = parseLiveHostArgs(['--', 'node', 'app.js', '--deployed-rules']);
    expect(afterSeparator).toEqual({
      kind: 'start',
      allowRemotePeers: false,
      deployedRules: false,
      passThrough: [],
      hostArgv: ['--', 'node', 'app.js', '--deployed-rules'],
    });
  });

  test('rejects --deployed-rules=<value> cleanly', () => {
    const bad = parseLiveHostArgs(['--deployed-rules=true']);
    expect(bad).toEqual({
      kind: 'error',
      message: 'pyric-live: --deployed-rules takes no value; pass --deployed-rules to opt in.',
    });
  });
});

describe('pyricLive deployedRules option', () => {
  test('accepts omitted, false, and true and rejects non-boolean values at startup', () => {
    expect(() => pyricLive()).not.toThrow();
    expect(() => pyricLive({ deployedRules: false })).not.toThrow();
    expect(() => pyricLive({ deployedRules: true })).not.toThrow();
    expect(() => pyricLive({ deployedRules: 'true' as unknown as boolean })).toThrow(
      '@pyric/live/vite: deployedRules must be a boolean.',
    );
  });
});

describe('pyric-live --deployed-rules CLI subprocess', () => {
  test('--help documents --deployed-rules and --deployed-rules=true exits non-zero fast', () => {
    const help = spawnSync('node', [liveCliDist, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--deployed-rules');
    expect(help.stdout).toContain('off by default');

    const bad = spawnSync('node', [liveCliDist, '--deployed-rules=true'], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('--deployed-rules takes no value');
  });

  test('omits live.deployedRules by default and exposes credential-free status when opted in', async () => {
    const projectDir = makeProjectDir();
    const isolatedHome = mkdtempSync(join(tmpdir(), 'pyric-live-home-'));
    tempDirs.push(isolatedHome);

    const secretToken = 'never-leak-this-cli-token';
    const configstoreDir = join(isolatedHome, '.config', 'configstore');
    mkdirSync(configstoreDir, { recursive: true });
    writeFileSync(
      join(configstoreDir, 'firebase-tools.json'),
      JSON.stringify({ tokens: { access_token: secretToken, expires_at: Date.now() + 3_600_000 } }),
    );

    const env = { ...process.env, HOME: isolatedHome, XDG_CONFIG_HOME: join(isolatedHome, '.config') };

    const portOff = await freeLoopbackPort();
    let offOutput = '';
    const childOff = spawn(
      'node',
      [liveCliDist, '--host', '127.0.0.1', '--port', String(portOff), '--no-open'],
      { cwd: projectDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    spawned.push(childOff);
    childOff.stdout.on('data', (chunk: Buffer) => { offOutput += chunk.toString('utf8'); });
    childOff.stderr.on('data', (chunk: Buffer) => { offOutput += chunk.toString('utf8'); });

    const healthOff = await waitForHealth(projectDir, portOff, childOff, () => offOutput);
    const liveOff = healthOff.body.live as Record<string, unknown>;
    expect(liveOff.deployedRules).toBeUndefined();
    expect(offOutput).not.toContain('deployed Security Rules inspection enabled');
    await stopChild(childOff);
    rmSync(join(projectDir, '.pyric', 'serve.json'), { force: true });

    const portOn = await freeLoopbackPort();
    let onOutput = '';
    const childOn = spawn(
      'node',
      [liveCliDist, '--host', '127.0.0.1', '--port', String(portOn), '--no-open', '--deployed-rules'],
      { cwd: projectDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    spawned.push(childOn);
    childOn.stdout.on('data', (chunk: Buffer) => { onOutput += chunk.toString('utf8'); });
    childOn.stderr.on('data', (chunk: Buffer) => { onOutput += chunk.toString('utf8'); });

    const healthOn = await waitForHealth(projectDir, portOn, childOn, () => onOutput);
    const liveOn = healthOn.body.live as Record<string, unknown>;
    expect(liveOn.deployedRules).toEqual({ enabled: true, services: [] });
    expect(onOutput).toContain('deployed Security Rules inspection enabled');
    expect(JSON.stringify(healthOn.body)).not.toContain(secretToken);
    expect(onOutput).not.toContain(secretToken);
  }, 30_000);
});
