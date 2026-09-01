/**
 * `pyric dev` child-runner decisions: `--` passthrough parsing, the
 * command-precedence matrix (`--` > dev script > none; --no-run / --json),
 * the child environment (activator + APPENDED NODE_OPTIONS), the register
 * module URL, and the `[dev]` line prefixer.
 */
import { describe, it, expect } from 'bun:test';
import { parseArgs } from '../../src/cli/parse-args.js';
import {
  BACKEND_ARTIFACT_DIRS,
  buildChildEnv,
  createLinePrefixer,
  describeInterlock,
  detectUnsupportedRuntime,
  formatInlinedArtifactWarnings,
  formatInterlockLine,
  formatUnsupportedRuntimeWarning,
  formatMissingBeaconWarning,
  formatStartupEnvExport,
  parseCommandString,
  registerModuleUrl,
  resolveSandboxChild,
  startBeaconWatchdog,
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

/**
 * TA.4-B — the INTERLOCK status line. Everything it reports is knowable
 * synchronously from the env `pyric dev` is about to hand the child: the
 * guard mode, whether NODE_OPTIONS actually carries the register import, and
 * the beacon endpoint the child will post to. It is a statement about the
 * LAUNCH, printed before anything can have gone wrong at runtime.
 */
const REGISTER_URL = 'file:///usr/local/pyric/dist/register/index.js';

describe('describeInterlock', () => {
  it('reads the guard mode, the register import and the beacon off the child env', () => {
    const env = buildChildEnv(
      { PYRIC_GUARD: 'block' } as NodeJS.ProcessEnv,
      { serveUrl: 'http://localhost:3473', registerUrl: REGISTER_URL },
    );
    expect(describeInterlock(env, REGISTER_URL)).toEqual({
      guard: 'block',
      registerImported: true,
      beacon: 'http://localhost:3473/__pyric/beacon',
    });
  });

  it('defaults the guard to warn and survives a user NODE_OPTIONS prefix', () => {
    const env = buildChildEnv(
      { NODE_OPTIONS: '--max-old-space-size=4096' } as NodeJS.ProcessEnv,
      { serveUrl: 'http://localhost:3473', registerUrl: REGISTER_URL },
    );
    const status = describeInterlock(env, REGISTER_URL);
    expect(status.guard).toBe('warn');
    expect(status.registerImported).toBe(true);
  });

  it('reports registerImported=false when NODE_OPTIONS lost the import', () => {
    const status = describeInterlock(
      { PYRIC_SANDBOX: 'remote:http://localhost:3473', NODE_OPTIONS: '--inspect' },
      REGISTER_URL,
    );
    expect(status.registerImported).toBe(false);
    expect(status.beacon).toBe('http://localhost:3473/__pyric/beacon');
  });
});

describe('formatInterlockLine', () => {
  it('is a ✔ line naming the guard mode, the loader and the beacon', () => {
    const line = formatInterlockLine({
      guard: 'warn',
      registerImported: true,
      beacon: 'http://localhost:3473/__pyric/beacon',
    });
    expect(line.startsWith('✔ interlock')).toBe(true);
    expect(line).toContain('guard=warn');
    expect(line).toContain('NODE_OPTIONS');
    expect(line).toContain('http://localhost:3473/__pyric/beacon');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('degrades to ⚠ and says what is lost when the register import is missing', () => {
    const line = formatInterlockLine({ guard: 'off', registerImported: false, beacon: null });
    expect(line.startsWith('⚠ interlock')).toBe(true);
    expect(line).toContain('guard=off');
    expect(line).toContain('NOT');
    expect(line).toContain('beacon=none');
  });
});

/**
 * TA.4-B — the WATCHDOG. Permanently warn-only: it never kills, never blocks,
 * and speaks at most once per child.
 */
describe('formatMissingBeaconWarning', () => {
  it('names the command, the wait, and what the silence means', () => {
    const line = formatMissingBeaconWarning({
      label: 'next dev',
      graceMs: 15_000,
      beacon: 'http://localhost:3473/__pyric/beacon',
    });
    expect(line).toContain('⚠ interlock');
    expect(line).toContain('next dev');
    expect(line).toContain('15s');
    expect(line).toContain('/__pyric/beacon');
    expect(line.toLowerCase()).toContain('warning only');
  });
});

describe('startBeaconWatchdog', () => {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('warns exactly once when a live child never posts its beacon', async () => {
    const warnings: string[] = [];
    startBeaconWatchdog({
      label: 'next dev',
      beacon: 'http://localhost:3473/__pyric/beacon',
      graceMs: 5,
      sawBeacon: () => false,
      isAlive: () => true,
      warn: (line) => warnings.push(line),
    });
    await wait(40);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('next dev');
  });

  it('stays silent when the beacon arrived', async () => {
    const warnings: string[] = [];
    startBeaconWatchdog({
      label: 'next dev',
      beacon: 'http://localhost:3473/__pyric/beacon',
      graceMs: 5,
      sawBeacon: () => true,
      isAlive: () => true,
      warn: (line) => warnings.push(line),
    });
    await wait(40);
    expect(warnings).toEqual([]);
  });

  it('stays silent when the child already exited — nothing was expected of it', async () => {
    const warnings: string[] = [];
    startBeaconWatchdog({
      label: 'node seed.js',
      beacon: 'http://localhost:3473/__pyric/beacon',
      graceMs: 5,
      sawBeacon: () => false,
      isAlive: () => false,
      warn: (line) => warnings.push(line),
    });
    await wait(40);
    expect(warnings).toEqual([]);
  });

  it('stays silent when there is no beacon endpoint to be absent from', async () => {
    const warnings: string[] = [];
    startBeaconWatchdog({
      label: 'next dev',
      beacon: null,
      graceMs: 5,
      sawBeacon: () => false,
      isAlive: () => true,
      warn: (line) => warnings.push(line),
    });
    await wait(40);
    expect(warnings).toEqual([]);
  });

  it('stop() cancels a pending warn', async () => {
    const warnings: string[] = [];
    const watchdog = startBeaconWatchdog({
      label: 'next dev',
      beacon: 'http://localhost:3473/__pyric/beacon',
      graceMs: 20,
      sawBeacon: () => false,
      isAlive: () => true,
      warn: (line) => warnings.push(line),
    });
    watchdog.stop();
    await wait(60);
    expect(warnings).toEqual([]);
  });
});

/**
 * TA.5-A — the pre-flight artifact scan's pure half: which dirs are worth
 * looking in, and how a finding reads.
 */
describe('BACKEND_ARTIFACT_DIRS', () => {
  it('covers the backend build outputs a launched child would actually load', () => {
    expect([...BACKEND_ARTIFACT_DIRS].sort()).toEqual(
      ['.next/server', 'build', 'dist', 'functions'].sort(),
    );
  });
});

describe('formatInlinedArtifactWarnings', () => {
  it('is empty for a clean scan', () => {
    expect(formatInlinedArtifactWarnings([])).toEqual([]);
  });

  it('names the file, the catalog service and the host, one line per file', () => {
    const lines = formatInlinedArtifactWarnings([
      { file: '.next/server/chunk.js', host: 'firestore.googleapis.com', service: 'Cloud Firestore' },
      {
        file: 'dist/server.cjs',
        host: 'identitytoolkit.googleapis.com',
        service: 'Firebase Authentication',
      },
    ]);
    expect(lines[0]).toContain('⚠ preflight');
    expect(lines[0]).toContain('.next/server/chunk.js');
    expect(lines[0]).toContain('Cloud Firestore');
    expect(lines[0]).toContain('firestore.googleapis.com');
    expect(lines[1]).toContain('dist/server.cjs');
    expect(lines[1]).toContain('Firebase Authentication');
    // A trailing line explains what a finding MEANS and that nothing was blocked.
    const summary = lines[lines.length - 1]!;
    expect(summary).toContain('2 build artifacts');
    expect(summary.toLowerCase()).toContain('module swap');
    expect(summary).toContain('LIVE Firebase');
    expect(summary.toLowerCase()).toContain('external');
    expect(summary.toLowerCase()).toContain('warning only');
  });

  it('caps the per-file lines so a badly built project cannot flood the console', () => {
    const hits = Array.from({ length: 40 }, (_, i) => ({
      file: `dist/chunk-${i}.js`,
      host: 'firestore.googleapis.com',
      service: 'Cloud Firestore',
    }));
    const lines = formatInlinedArtifactWarnings(hits);
    expect(lines.length).toBeLessThan(15);
    expect(lines.some((l) => l.includes('more'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('40 build artifacts');
  });
});

/**
 * TA.5-B — adopted decision 4. Command-name detection is the honest 90%; the
 * warning is explicit that neither the loader swap NOR the net-guard backstop
 * covers this child.
 */
describe('detectUnsupportedRuntime', () => {
  it('detects a bare bun/deno command', () => {
    expect(detectUnsupportedRuntime(['bun', 'run', 'dev'])).toBe('bun');
    expect(detectUnsupportedRuntime(['deno', 'task', 'dev'])).toBe('deno');
  });

  it('detects bunx and an absolute/relative path to the binary', () => {
    expect(detectUnsupportedRuntime(['bunx', 'vite'])).toBe('bun');
    expect(detectUnsupportedRuntime(['/usr/local/bin/bun', 'server.ts'])).toBe('bun');
    expect(detectUnsupportedRuntime(['./node_modules/.bin/deno', 'run', 'x.ts'])).toBe('deno');
    expect(detectUnsupportedRuntime(['C:\\tools\\bun.exe', 'start'])).toBe('bun');
  });

  it('looks past leading KEY=VAL assignments and shell operators', () => {
    expect(detectUnsupportedRuntime(['PORT=8080', 'bun', 'start'])).toBe('bun');
    expect(detectUnsupportedRuntime(['npm', 'run', 'build', '&&', 'bun', 'start'])).toBe('bun');
  });

  it('stays null for supported runtimes and for names that merely contain bun', () => {
    expect(detectUnsupportedRuntime(['node', 'server.js'])).toBeNull();
    expect(detectUnsupportedRuntime(['npx', 'tsx', 'server.ts'])).toBeNull();
    expect(detectUnsupportedRuntime(['npm', 'run', 'dev'])).toBeNull();
    expect(detectUnsupportedRuntime(['bundle', 'exec', 'rails'])).toBeNull();
    expect(detectUnsupportedRuntime(['./bunny.sh'])).toBeNull();
    expect(detectUnsupportedRuntime([])).toBeNull();
  });
});

describe('formatUnsupportedRuntimeWarning', () => {
  it('says interception is unsupported, names the live risk, and disclaims the net guard', () => {
    const line = formatUnsupportedRuntimeWarning('bun');
    expect(line).toContain('⚠ runtime');
    expect(line).toContain('bun');
    expect(line).toContain('not supported');
    expect(line).toContain('NOT be rewritten');
    expect(line).toContain('LIVE Firebase');
    expect(line).toContain('net-guard');
    expect(line).toContain('Node');
    expect(line.toLowerCase()).toContain('warning only');
    expect(line.endsWith('\n')).toBe(true);
  });
});
