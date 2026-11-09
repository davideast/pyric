import { afterEach, describe, it, expect } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArgs } from '../../src/cli/parse-args.js';
import { DEFAULT_WAIT_SECONDS, notAHostMessage, parseRunInvocation, pollUntil } from '../../src/cli/run.js';
import { runDispatch } from './run-cli.js';

const parse = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseRunInvocation(parseArgs(['run', ...argv]), env);

describe('parseRunInvocation', () => {
  it('runs the command after -- against the host --sandbox names', () => {
    expect(parse(['--sandbox', 'remote:http://localhost:5173', '--', 'node', 'dist/index.js', '--port', '1'])).toEqual({
      hostUrl: 'http://localhost:5173',
      plan: { argv: ['node', 'dist/index.js', '--port', '1'], label: 'node dist/index.js --port 1' },
      waitMs: 0,
    });
  });

  it('accepts a bare URL for --sandbox', () => {
    const invocation = parse(['--sandbox=http://127.0.0.1:3473', '--', 'node', 'a.js']);
    expect(typeof invocation === 'string' ? invocation : invocation.hostUrl).toBe('http://127.0.0.1:3473');
  });

  it('falls back to an inherited PYRIC_SANDBOX=remote:<url>', () => {
    const invocation = parse(['--', 'node', 'a.js'], { PYRIC_SANDBOX: 'remote:http://localhost:5173' });
    expect(typeof invocation === 'string' ? invocation : invocation.hostUrl).toBe('http://localhost:5173');
  });

  it('leaves the host to discovery when nothing names a URL', () => {
    const invocation = parse(['--', 'node', 'a.js'], { PYRIC_SANDBOX: 'remote' });
    expect(typeof invocation === 'string' ? invocation : invocation.hostUrl).toBeNull();
  });

  it('prefers --sandbox over the inherited activator', () => {
    const invocation = parse(['--sandbox', 'http://localhost:1', '--', 'node'], { PYRIC_SANDBOX: 'remote:http://localhost:2' });
    expect(typeof invocation === 'string' ? invocation : invocation.hostUrl).toBe('http://localhost:1');
  });

  it('refuses a missing command', () => {
    expect(parse(['--sandbox', 'http://localhost:1'])).toMatch(/^pyric run: no command to run\./);
  });

  it('refuses a --sandbox that names no URL', () => {
    expect(parse(['--sandbox', '--', 'node'])).toMatch(/^pyric run: --sandbox needs a host URL/);
    expect(parse(['--sandbox', 'localhost:5173', '--', 'node'])).toMatch(/^pyric run: --sandbox needs a host URL/);
  });

  it('waits the default bound for a bare --wait', () => {
    const invocation = parse(['--sandbox', 'http://localhost:1', '--wait', '--', 'node']);
    expect(typeof invocation === 'string' ? invocation : invocation.waitMs).toBe(DEFAULT_WAIT_SECONDS * 1000);
  });

  it('waits the seconds --wait names', () => {
    for (const flags of [['--wait=90'], ['--wait', '90']]) {
      const invocation = parse(['--sandbox', 'http://localhost:1', ...flags, '--', 'node']);
      expect(typeof invocation === 'string' ? invocation : invocation.waitMs).toBe(90_000);
    }
  });

  it('refuses a --wait that is not a positive number of seconds', () => {
    for (const value of ['soon', '0', '-5']) {
      expect(parse(['--sandbox', 'http://localhost:1', `--wait=${value}`, '--', 'node'])).toMatch(/^pyric run: --wait takes a number of seconds/);
    }
  });
});

describe('pollUntil', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  it('returns the first value an attempt yields', async () => {
    const answers = [null, null, 'host'];
    const { now, sleep } = clock();
    expect(await pollUntil(async () => answers.shift() ?? null, { timeoutMs: 10_000, now, sleep })).toBe('host');
    expect(answers).toEqual([]);
  });

  it('gives up with null once the deadline passes', async () => {
    let attempts = 0;
    const { now, sleep } = clock();
    const result = await pollUntil(async () => { attempts += 1; return null; }, { timeoutMs: 1_000, intervalMs: 250, now, sleep });
    expect(result).toBeNull();
    expect(attempts).toBe(5);
  });

  it('makes exactly one attempt with a zero timeout', async () => {
    let attempts = 0;
    const { now, sleep } = clock();
    expect(await pollUntil(async () => { attempts += 1; return null; }, { timeoutMs: 0, now, sleep })).toBeNull();
    expect(attempts).toBe(1);
  });
});

describe('pyric run --sandbox against a server that is not a sandbox host (#1568)', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  });

  /** A server that answers 404 to everything except `paths`, as an in-page Vite server answers a JSON request. */
  async function serveOnly(paths: string[]): Promise<string> {
    const server = createServer((req, res) => {
      const isServed = paths.includes(req.url ?? '');
      if (isServed) res.writeHead(200, { 'content-type': 'text/javascript' }).end('export {}');
      else res.writeHead(404).end();
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function runAgainst(url: string): Promise<{ code: number; stderr: string; ms: number }> {
    const started = Date.now();
    const { code, stderr } = await runDispatch(['run', '--sandbox', url, '--wait=5', '--', 'node', '-e', '0']);
    return { code, stderr, ms: Date.now() - started };
  }

  it('refuses an in-page Vite server at once and names pyric({ hosted: true })', async () => {
    const url = await serveOnly(['/@vite/env']);
    const { code, stderr, ms } = await runAgainst(url);
    expect(code).toBe(2);
    expect(stderr).toContain(`reached a Vite server without a hosted pyric sandbox at ${url}`);
    expect(stderr).toContain('pyric({ hosted: true }) in vite.config.ts');
    expect(ms).toBeLessThan(4000);
  });

  it('refuses any other server at once and names both ways to start a host', async () => {
    const url = await serveOnly([]);
    const { code, stderr, ms } = await runAgainst(url);
    expect(code).toBe(2);
    expect(stderr).toContain(`${url} answers, but it is not a sandbox host`);
    expect(stderr).toContain('pyric sandbox --hosted');
    expect(stderr).toContain('pyric({ hosted: true })');
    expect(ms).toBeLessThan(4000);
  });
});

describe('notAHostMessage', () => {
  it('names the Vite config file it is given, in both refusals', () => {
    for (const isVite of [true, false]) {
      expect(notAHostMessage('http://localhost:5173', isVite, 'vite.config.mjs')).toContain('pyric({ hosted: true }) in vite.config.mjs');
    }
  });

  it('claims only what the Vite check shows', () => {
    const message = notAHostMessage('http://localhost:5173', true, 'vite.config.ts');
    expect(message).toContain('a Vite server without a hosted pyric sandbox');
    expect(message).not.toContain('in-page');
  });
});

describe('pyric run --help', () => {
  it('says the Vite dev server must be hosted', async () => {
    const { code, stdout } = await runDispatch(['run', '--help']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/run \[--sandbox URL\][\s\S]*pyric\(\{ hosted: true \}\)/);
  });
});

describe('pyric run unsupported runtime stop and PYRIC_GUARD deprecation', () => {
  it('stops upfront with PYRIC_UNSUPPORTED_RUNTIME before polling --sandbox for bun, bunx, and deno', async () => {
    for (const [cmd, expectedRuntime] of [
      [['bun', 'run', 'script.ts'], 'bun'],
      [['bunx', 'tsx', 'script.ts'], 'bun'],
      [['deno', 'run', 'script.ts'], 'deno'],
    ] as const) {
      const started = Date.now();
      const { code, stderr } = await runDispatch([
        'run',
        '--sandbox',
        'http://127.0.0.1:9',
        '--wait=30',
        '--',
        ...cmd,
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain('pyric run: stopped before starting');
      expect(stderr).toContain('PYRIC_UNSUPPORTED_RUNTIME');
      expect(stderr).toContain(`\`${expectedRuntime}\``);
      expect(stderr).toContain('npx tsx');
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });

  it('emits a deprecation warning to stderr when PYRIC_GUARD is set', async () => {
    const warnedKey = Symbol.for('pyric.deprecatedGuardEnvWarned');
    const slot = globalThis as unknown as Record<symbol, unknown>;
    const priorWarned = slot[warnedKey];
    const priorGuard = process.env.PYRIC_GUARD;
    delete slot[warnedKey];
    process.env.PYRIC_GUARD = 'strict';
    try {
      const { code, stderr } = await runDispatch(['run', '--sandbox', 'http://localhost:1']);
      expect(code).toBe(1);
      expect(stderr).toContain('PYRIC_GUARD is deprecated and ignored');
    } finally {
      if (priorWarned === undefined) delete slot[warnedKey];
      else slot[warnedKey] = priorWarned;
      if (priorGuard === undefined) delete process.env.PYRIC_GUARD;
      else process.env.PYRIC_GUARD = priorGuard;
    }
  });
});
