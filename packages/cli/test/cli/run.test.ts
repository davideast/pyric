import { describe, it, expect } from 'bun:test';
import { parseArgs } from '../../src/cli/parse-args.js';
import { DEFAULT_WAIT_SECONDS, parseRunInvocation, pollUntil } from '../../src/cli/run.js';

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
