import { describe, it, expect } from 'bun:test';
import { createDeployReporter } from '../../src/cli/deploy-progress.js';

function sink() {
  const lines: string[] = [];
  return { lines, write: (s: string) => void lines.push(s) };
}

describe('createDeployReporter', () => {
  it('machine mode: emits the result as JSON; progress is suppressed', () => {
    const out = sink();
    const err = sink();
    const r = createDeployReporter({ out, err, machineOutput: true, isTTY: false });
    r.report({ target: 'storage', step: 'settle', status: 'start', message: 'waiting' });
    r.result({ ok: true, summary: 'done', data: { bucketId: 'b' } });
    r.dispose();
    expect(out.lines.join('')).toContain('"ok":true');
    expect(out.lines.join('')).not.toContain('settle'); // progress is interactive-only
  });

  it('machine mode: a failed result goes to stderr', () => {
    const out = sink();
    const err = sink();
    const r = createDeployReporter({ out, err, machineOutput: true, isTTY: false });
    r.result({ ok: false, summary: 'nope' });
    r.dispose();
    expect(err.lines.join('')).toContain('"ok":false');
  });

  it('flat (non-TTY): summary only, progress suppressed', () => {
    const out = sink();
    const err = sink();
    const r = createDeployReporter({ out, err, machineOutput: false, isTTY: false });
    r.report({ target: 'storage', step: 'settle', status: 'start', message: 'waiting' });
    r.result({ ok: true, summary: 'Provisioned bucket b' });
    r.dispose();
    expect(out.lines.join('')).toBe('Provisioned bucket b\n');
  });
});
