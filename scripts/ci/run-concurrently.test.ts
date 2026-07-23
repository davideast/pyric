import { describe, expect, it } from 'bun:test';
import { parseStreams } from './run-concurrently.ts';
import rootManifest from '../../package.json';

const RUNNER = new URL('./run-concurrently.ts', import.meta.url).pathname;

async function runRunner(args: string[]): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(['bun', RUNNER, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: output + errors };
}

describe('parseStreams', () => {
  it('splits label=command on the first equals sign only', () => {
    expect(parseStreams(['a=echo x', 'b=FOO=1 env'])).toEqual([
      { label: 'a', command: 'echo x' },
      { label: 'b', command: 'FOO=1 env' },
    ]);
  });

  it('rejects fewer than two streams and malformed arguments', () => {
    expect(() => parseStreams(['only=one'])).toThrow('at least two');
    expect(() => parseStreams(['a=x', 'nolabel'])).toThrow('Expected "label=command"');
    expect(() => parseStreams(['a=x', 'empty='])).toThrow('Expected "label=command"');
  });
});

describe('run-concurrently', () => {
  it('runs streams concurrently, prefixes output, and exits 0 when all pass', async () => {
    const result = await runRunner(['one=echo first', 'two=echo second']);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('[one] first');
    expect(result.output).toContain('[two] second');
    expect(result.output).toContain('2 streams finished');
  });

  it('lets every stream finish and fails if any stream failed', async () => {
    const result = await runRunner(['bad=exit 3', 'slow=sleep 0.2 && echo done']);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('[slow] done'); // the slow stream still ran to completion
    expect(result.output).toContain('bad: exit 3');
    expect(result.output).toContain('failed: bad');
  });
});

describe('CI stream composition', () => {
  it('test:ci:libraries:core is exactly test:ci:libraries minus the conformance suite', () => {
    const scripts = rootManifest.scripts as Record<string, string>;
    const conformanceSegment = ' && bun test --cwd packages/conformance';
    expect(scripts['test:ci:libraries']).toContain(conformanceSegment);
    expect(scripts['test:ci:libraries:core']).not.toContain('packages/conformance');
    expect(scripts['test:ci:libraries'].replace(conformanceSegment, ''))
      .toBe(scripts['test:ci:libraries:core']);
  });
});
