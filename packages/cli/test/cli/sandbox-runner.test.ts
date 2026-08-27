/**
 * `pyric dev` child-runner decisions: `--` passthrough parsing, the
 * command-precedence matrix (`--` > dev script > none; --no-run / --json),
 * the child environment (activator + APPENDED NODE_OPTIONS), the register
 * module URL, and the `[dev]` line prefixer.
 */
import { describe, it, expect } from 'bun:test';
import { parseArgs } from '../../src/cli/parse-args.js';
import {
  buildChildEnv,
  createLinePrefixer,
  formatStartupEnvExport,
  parseCommandString,
  registerModuleUrl,
  resolveSandboxChild,
  waitForSandboxPeer,
} from '../../src/cli/sandbox-runner.js';

describe('parseArgs `--` passthrough', () => {
  it('collects everything after -- verbatim, never as flags', () => {
    const parsed = parseArgs(['sandbox', '--bridge', '--', 'npm', 'start', '--port', '3000']);
    expect(parsed.subcommand).toBe('sandbox');
    expect(parsed.flags.get('bridge')).toBe(true);
    expect(parsed.passthrough).toEqual(['npm', 'start', '--port', '3000']);
    expect(parsed.flags.has('port')).toBe(false);
  });

  it('is empty without --', () => {
    expect(parseArgs(['sandbox', '--json']).passthrough).toEqual([]);
  });

  it('collects positional command and arguments under sandbox without --', () => {
    const parsed = parseArgs(['sandbox', '--port', '4000', 'next', 'dev', '--turbo']);
    expect(parsed.subcommand).toBe('sandbox');
    expect(parsed.flags.get('port')).toBe('4000');
    expect(parsed.positional).toEqual(['next', 'dev', '--turbo']);
    expect(parsed.flags.has('turbo')).toBe(false);
  });

  it('collects node flags under sandbox without --', () => {
    const parsed = parseArgs(['sandbox', 'node', '-e', 'console.log(1)']);
    expect(parsed.subcommand).toBe('sandbox');
    expect(parsed.positional).toEqual(['node', '-e', 'console.log(1)']);
    expect(parsed.flags.has('e')).toBe(false);
  });

  it('maps -p 4000 to port flag and preserves child command', () => {
    const parsed = parseArgs(['sandbox', '-p', '4000', 'next', 'dev']);
    expect(parsed.subcommand).toBe('sandbox');
    expect(parsed.flags.get('port')).toBe('4000');
    expect(parsed.positional).toEqual(['next', 'dev']);
  });
});

describe('parseCommandString', () => {
  it('tokenizes standard commands by space', () => {
    expect(parseCommandString('next dev')).toEqual(['next', 'dev']);
    expect(parseCommandString('npm run dev:server')).toEqual(['npm', 'run', 'dev:server']);
  });

  it('preserves double and single quoted strings', () => {
    expect(parseCommandString('node -e "console.log(1)"')).toEqual([
      'node',
      '-e',
      'console.log(1)',
    ]);
    expect(parseCommandString("node -e 'console.log(2)'")).toEqual([
      'node',
      '-e',
      'console.log(2)',
    ]);
  });
});

describe('resolveSandboxChild precedence', () => {
  const base = {
    explicitCommand: null as string[] | null,
    passthrough: [] as string[],
    configCommand: null as string | null,
    noRun: false,
    json: false,
  };

  it('explicit CLI command wins over pyric.json config command', () => {
    const plan = resolveSandboxChild({
      ...base,
      explicitCommand: ['node', 'server.js'],
      configCommand: 'next dev',
    });
    expect(plan).toEqual({ argv: ['node', 'server.js'], label: 'node server.js' });
  });

  it('passthrough -- command wins over pyric.json config command', () => {
    const plan = resolveSandboxChild({
      ...base,
      passthrough: ['node', 'server.js'],
      configCommand: 'next dev',
    });
    expect(plan).toEqual({ argv: ['node', 'server.js'], label: 'node server.js' });
  });

  it('falls back to pyric.json configCommand when no CLI command is given', () => {
    const plan = resolveSandboxChild({ ...base, configCommand: 'next dev --port 3000' });
    expect(plan).toEqual({ argv: ['next', 'dev', '--port', '3000'], label: 'next dev --port 3000' });
  });

  it('no explicit command and no config command → host-only (null)', () => {
    expect(resolveSandboxChild(base)).toBeNull();
  });

  it('--no-run forces host-only, even with an explicit command and config', () => {
    expect(
      resolveSandboxChild({
        ...base,
        noRun: true,
        explicitCommand: ['npm', 'start'],
        configCommand: 'next dev',
      }),
    ).toBeNull();
  });

  it('--json defaults to host-only (skips configCommand)', () => {
    expect(resolveSandboxChild({ ...base, json: true, configCommand: 'next dev' })).toBeNull();
  });

  it('--json with an explicit command still runs it', () => {
    const plan = resolveSandboxChild({
      ...base,
      json: true,
      explicitCommand: ['node', 'x.js'],
    });
    expect(plan?.argv).toEqual(['node', 'x.js']);
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
