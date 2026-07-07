/** Strategy-stepper model — milestone mapping + graceful degradation. */
import { describe, test, expect } from 'bun:test';
import { buildStrategySteps } from './strategy-steps';

describe('buildStrategySteps', () => {
  test('plain ReAct turn (no events, no critiques) → [] — stepper renders nothing', () => {
    expect(buildStrategySteps(undefined, undefined)).toEqual([]);
    expect(buildStrategySteps([], [])).toEqual([]);
  });

  test('draft-validate happy path: draft → validate ok', () => {
    const steps = buildStrategySteps([
      { name: 'draft_started', data: { attempt: 0 } },
      { name: 'validation_result', data: { passed: 4, total: 4 } },
    ]);
    expect(steps.map((s) => [s.label, s.tone])).toEqual([
      ['draft', 'neutral'],
      ['validate 4/4', 'ok'],
    ]);
  });

  test('repair loop: failing validation warns, repair warns, final validation ok', () => {
    const steps = buildStrategySteps([
      { name: 'draft_started', data: { attempt: 0 } },
      { name: 'validation_result', data: { passed: 2, total: 4 } },
      { name: 'repair_started', data: { failures: 2 } },
      { name: 'draft_started', data: { attempt: 1 } },
      { name: 'validation_result', data: { passed: 4, total: 4 } },
    ]);
    expect(steps.map((s) => s.tone)).toEqual(['neutral', 'warn', 'warn', 'neutral', 'ok']);
    expect(steps[1]!.label).toBe('validate 2/4');
    expect(steps[3]!.label).toBe('revision 1');
  });

  test('exhausted validation is a fail step', () => {
    const steps = buildStrategySteps([
      { name: 'validation_exhausted', data: { remaining: 3 } },
    ]);
    expect(steps[0]!.tone).toBe('fail');
    expect(steps[0]!.label).toContain('3 unresolved');
  });

  test('skipped validation carries the reason as detail', () => {
    const steps = buildStrategySteps([
      { name: 'validation_result', data: { skipped: true, reason: 'no rules present' } },
    ]);
    expect(steps[0]!.label).toBe('validation skipped');
    expect(steps[0]!.detail).toBe('no rules present');
    expect(steps[0]!.tone).toBe('neutral');
  });

  test('unknown escalation-shaped milestone (future C2) renders generically as warn', () => {
    const steps = buildStrategySteps([
      {
        name: 'strategy_escalated',
        data: { reason: 'repairs exhausted — re-running under react' },
      },
    ]);
    expect(steps[0]!.tone).toBe('warn');
    expect(steps[0]!.label).toBe('strategy escalated');
    expect(steps[0]!.detail).toContain('re-running under react');
  });

  test('unknown neutral milestone humanizes the name', () => {
    const steps = buildStrategySteps([{ name: 'plan_committed' }]);
    expect(steps[0]!.label).toBe('plan committed');
    expect(steps[0]!.tone).toBe('neutral');
  });

  test('reflexion critiques map verdicts to tones and carry feedback', () => {
    const steps = buildStrategySteps(undefined, [
      { verdict: 'retry', feedback: 'cover the unauthenticated case' },
      { verdict: 'ok' },
    ]);
    expect(steps.map((s) => s.tone)).toEqual(['warn', 'ok']);
    expect(steps[0]!.detail).toBe('cover the unauthenticated case');
    expect(steps[1]!.detail).toBeUndefined();
  });

  test('exhausted critique is a fail step', () => {
    const steps = buildStrategySteps(undefined, [
      { verdict: 'exhausted', feedback: 'still wrong' },
    ]);
    expect(steps[0]!.tone).toBe('fail');
    expect(steps[0]!.label).toContain('retries spent');
  });

  test('streaming appends a running chip (any provider / strategy)', () => {
    expect(buildStrategySteps([], [], true)).toEqual([
      { id: 'running', label: 'running', tone: 'neutral' },
    ]);
    expect(buildStrategySteps([{ name: 'strategy_routed' }], [], true).map((s) => s.label)).toEqual([
      'strategy routed',
      'running',
    ]);
  });
});
