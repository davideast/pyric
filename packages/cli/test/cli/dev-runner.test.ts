/**
 * `pyric dev` child-runner decisions: `--` passthrough parsing, the
 * command-precedence matrix (`--` > dev script > none; --no-run / --json),
 * the child environment (activator + APPENDED NODE_OPTIONS), the register
 * module URL, and the `[dev]` line prefixer.
 */
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../../src/cli/parse-args.js';
import {
  buildChildEnv,
  createLinePrefixer,
  detectPackageManager,
  formatStartupEnvExport,
  readDevScript,
  registerModuleUrl,
  resolveDevChild,
  waitForSandboxPeer,
} from '../../src/cli/dev-runner.js';

describe('parseArgs `--` passthrough', () => {
  it('collects everything after -- verbatim, never as flags', () => {
    const parsed = parseArgs(['dev', '--bridge', '--', 'npm', 'start', '--port', '3000']);
    expect(parsed.subcommand).toBe('dev');
    expect(parsed.flags.get('bridge')).toBe(true);
    expect(parsed.passthrough).toEqual(['npm', 'start', '--port', '3000']);
    expect(parsed.flags.has('port')).toBe(false);
  });

  it('is empty without --', () => {
    expect(parseArgs(['dev', '--json']).passthrough).toEqual([]);
  });

  it('handles a trailing bare --', () => {
    expect(parseArgs(['dev', '--']).passthrough).toEqual([]);
  });
});

describe('resolveDevChild precedence', () => {
  const base = {
    passthrough: [] as string[],
    noRun: false,
    json: false,
    devScript: null as string | null,
    packageManager: 'npm' as const,
  };

  it('explicit -- command wins over the dev script', () => {
    const plan = resolveDevChild({ ...base, passthrough: ['node', 'server.js'], devScript: 'vite' });
    expect(plan).toEqual({ argv: ['node', 'server.js'], label: 'node server.js' });
  });

  it('falls back to the dev script via the detected package manager', () => {
    const plan = resolveDevChild({ ...base, devScript: 'vite dev', packageManager: 'bun' });
    expect(plan).toEqual({ argv: ['bun', 'run', 'dev'], label: 'bun run dev' });
  });

  it('no -- and no dev script → host-only', () => {
    expect(resolveDevChild(base)).toBeNull();
  });

  it('--no-run forces host-only, even with -- and a dev script', () => {
    expect(
      resolveDevChild({ ...base, noRun: true, passthrough: ['npm', 'start'], devScript: 'vite' }),
    ).toBeNull();
  });

  it('--json defaults to host-only (skips the dev script)', () => {
    expect(resolveDevChild({ ...base, json: true, devScript: 'vite' })).toBeNull();
  });

  it('--json with an explicit -- command still runs it', () => {
    const plan = resolveDevChild({ ...base, json: true, passthrough: ['node', 'x.js'] });
    expect(plan?.argv).toEqual(['node', 'x.js']);
  });

  it('a dev script that itself runs pyric dev is skipped (no recursion)', () => {
    expect(resolveDevChild({ ...base, devScript: 'pyric dev --bridge' })).toBeNull();
    expect(resolveDevChild({ ...base, devScript: 'rimraf dist && pyric dev' })).toBeNull();
  });
});

describe('detectPackageManager / readDevScript', () => {
  it('sniffs lockfiles, defaulting to npm', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-pm-'));
    try {
      expect(detectPackageManager(dir)).toBe('npm');
      writeFileSync(join(dir, 'yarn.lock'), '');
      expect(detectPackageManager(dir)).toBe('yarn');
      writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
      expect(detectPackageManager(dir)).toBe('pnpm');
      writeFileSync(join(dir, 'bun.lock'), '');
      expect(detectPackageManager(dir)).toBe('bun');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads scripts.dev, tolerating missing/invalid package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-devscript-'));
    try {
      expect(readDevScript(dir)).toBeNull();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite dev' } }));
      expect(readDevScript(dir)).toBe('vite dev');
      writeFileSync(join(dir, 'package.json'), '{not json');
      expect(readDevScript(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildChildEnv', () => {
  it('sets the activator and appends --import to an existing NODE_OPTIONS', () => {
    const env = buildChildEnv(
      { NODE_OPTIONS: '--max-old-space-size=4096', PATH: '/bin' },
      { serveUrl: 'http://localhost:5000', registerUrl: 'file:///x/register/index.js' },
    );
    expect(env.PYRIC_SANDBOX).toBe('remote:http://localhost:5000');
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096 --import file:///x/register/index.js');
    expect(env.PATH).toBe('/bin');
  });

  it('creates NODE_OPTIONS when absent', () => {
    const env = buildChildEnv({}, { serveUrl: 'http://h:1', registerUrl: 'file:///r.js' });
    expect(env.NODE_OPTIONS).toBe('--import file:///r.js');
  });
});

describe('registerModuleUrl', () => {
  it('resolves to an absolute file URL of the register module', () => {
    const url = registerModuleUrl();
    expect(url.startsWith('file://')).toBe(true);
    expect(url).toContain('register/index');
  });
});

describe('createLinePrefixer', () => {
  it('prefixes complete lines and buffers partials until flush', () => {
    const out: string[] = [];
    const p = createLinePrefixer('[dev] ', (line) => out.push(line));
    p.push('hello\nwor');
    p.push('ld\ntail');
    expect(out).toEqual(['[dev] hello\n', '[dev] world\n']);
    p.flush();
    expect(out).toEqual(['[dev] hello\n', '[dev] world\n', '[dev] tail\n']);
    p.flush(); // idempotent
    expect(out).toHaveLength(3);
  });
});

describe('waitForSandboxPeer (first-run race guard)', () => {
  const health = (connected: boolean) =>
    ({ ok: true, json: async () => ({ sandboxConnected: connected }) }) as Response;

  it('resolves true as soon as the health endpoint reports a peer', async () => {
    let calls = 0;
    const ok = await waitForSandboxPeer('http://localhost:1', {
      timeoutMs: 5000,
      intervalMs: 1,
      fetchImpl: async () => health(++calls >= 3),
      sleep: async () => {},
    });
    expect(ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('returns false at the deadline when no peer ever connects', async () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const ok = await waitForSandboxPeer('http://localhost:1', {
        timeoutMs: 1000,
        intervalMs: 100,
        fetchImpl: async () => health(false),
        sleep: async () => { now += 100; },
      });
      expect(ok).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it('tolerates fetch failures while the server boots', async () => {
    let calls = 0;
    const ok = await waitForSandboxPeer('http://localhost:1/', {
      timeoutMs: 5000,
      intervalMs: 1,
      fetchImpl: async () => {
        calls++;
        if (calls < 2) throw new Error('ECONNREFUSED');
        return health(true);
      },
      sleep: async () => {},
    });
    expect(ok).toBe(true);
  });
});

describe('formatStartupEnvExport', () => {
  it('formats copy-pasteable POSIX export commands for host-only startup', () => {
    const output = formatStartupEnvExport({
      serveUrl: 'http://localhost:3473',
      registerUrl: 'file:///usr/local/pyric/dist/register/index.js',
    });
    expect(output).toContain('export PYRIC_SANDBOX="remote:http://localhost:3473"');
    expect(output).toContain(
      'export NODE_OPTIONS="--import file:///usr/local/pyric/dist/register/index.js"',
    );
    expect(output).toContain('To run external commands against this sandbox');
  });
});
