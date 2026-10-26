import { describe, it, expect } from 'bun:test';
import { parseArgs } from '../../src/cli/parse-args.js';
import { parseRunInvocation } from '../../src/cli/run.js';

const parse = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseRunInvocation(parseArgs(['run', ...argv]), env);

describe('parseRunInvocation', () => {
  it('runs the command after -- against the host --sandbox names', () => {
    expect(parse(['--sandbox', 'remote:http://localhost:5173', '--', 'node', 'dist/index.js', '--port', '1'])).toEqual({
      hostUrl: 'http://localhost:5173',
      plan: { argv: ['node', 'dist/index.js', '--port', '1'], label: 'node dist/index.js --port 1' },
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
});
