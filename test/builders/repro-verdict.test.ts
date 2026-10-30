import { describe, expect, test } from 'bun:test';
import type { ReproTarget } from './repro-target.ts';
import { judgeTry, reproResult, type TryEvidence } from './repro-verdict.ts';
import type { PhaseResult } from './run-phase.ts';

const PROBLEM: ReproTarget = {
  kind: 'builder-problem',
  selector: 'p1',
  slug: 'p1',
  problem: { id: 'p1', summary: 's', step: 1, docsLedMeToExpect: null, whatHappened: 'w', errorText: 'boom', logs: [], reproHint: 'h' },
};
const HOST: ReproTarget = { kind: 'google-host', selector: 'google-host:firestore.googleapis.com', slug: 'g', host: 'firestore.googleapis.com' };

const ended = (code: number | null, extra: Partial<PhaseResult> = {}): PhaseResult => ({ code, timedOut: false, error: null, wallMs: 1000, ...extra });
const evidence = (exit: PhaseResult | null, output = '', googleHosts: string[] = []): TryEvidence => ({ exit, output, googleHosts });

describe('judgeTry for a builder problem', () => {
  test('exit 1 reproduces, exit 0 does not', () => {
    expect(judgeTry(PROBLEM, evidence(ended(1))).outcome).toBe('reproduced');
    expect(judgeTry(PROBLEM, evidence(ended(0))).outcome).toBe('not-reproduced');
  });

  test('any other ending is inconclusive, never a reproduction', () => {
    expect(judgeTry(PROBLEM, evidence(ended(2))).outcome).toBe('inconclusive');
    expect(judgeTry(PROBLEM, evidence(ended(null, { timedOut: true }))).outcome).toBe('inconclusive');
    expect(judgeTry(PROBLEM, evidence(ended(null, { error: 'spawn node ENOENT' }))).outcome).toBe('inconclusive');
    expect(judgeTry(PROBLEM, evidence(null)).outcome).toBe('inconclusive');
  });

  test('with an expected text, exit 1 reproduces only when the output holds it', () => {
    expect(judgeTry(PROBLEM, evidence(ended(1), 'Error: boom'), 'boom').outcome).toBe('reproduced');
    expect(judgeTry(PROBLEM, evidence(ended(1), 'TypeError: x is undefined'), 'boom')).toEqual({
      outcome: 'inconclusive',
      reason: 'the script exited 1, but its output does not hold the expected text "boom"',
    });
  });

  test('a Google host the try reached is not what decides a builder problem', () => {
    expect(judgeTry(PROBLEM, evidence(ended(0), '', ['firestore.googleapis.com'])).outcome).toBe('not-reproduced');
  });
});

describe('judgeTry for a Google host', () => {
  test('reproduces when the try reached for the host, whatever the exit code', () => {
    expect(judgeTry(HOST, evidence(ended(0), '', ['firestore.googleapis.com'])).outcome).toBe('reproduced');
    expect(judgeTry(HOST, evidence(ended(2), '', ['firestore.googleapis.com'])).outcome).toBe('reproduced');
  });

  test('does not reproduce on another host', () => {
    expect(judgeTry(HOST, evidence(ended(1), '', ['oauth2.googleapis.com'])).outcome).toBe('not-reproduced');
  });
});

describe('reproResult', () => {
  test('one reproduced try is enough; otherwise unconfirmed', () => {
    expect(reproResult(['not-reproduced', 'reproduced'])).toBe('reproduced');
    expect(reproResult(['inconclusive', 'not-reproduced'])).toBe('unconfirmed');
    expect(reproResult([])).toBe('unconfirmed');
  });
});
