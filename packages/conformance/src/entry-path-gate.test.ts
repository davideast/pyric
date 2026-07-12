import { describe, expect, test } from 'bun:test';
import { entryPathGateExitCode, runEntryPathGate, type EntryPathReport } from './entry-path-gate.ts';

function reportOf(results: EntryPathReport['results'], unknownProgramCitations: string[] = []): EntryPathReport {
  return { generatedAt: new Date().toISOString(), results, unknownProgramCitations };
}

describe('entryPathGateExitCode — CLIFF semantics (pure)', () => {
  test('all green exits 0', () => {
    const report = reportOf([
      { program: 'auth', verdict: 'green' },
      { program: 'firestore', verdict: 'green' },
    ]);
    expect(entryPathGateExitCode(report)).toBe(0);
  });

  test('a red-known program (cited failure) still exits 0', () => {
    const report = reportOf([
      { program: 'auth', verdict: 'green' },
      {
        program: 'firestore',
        verdict: 'red-known',
        error: 'boom',
        expectedFailure: { program: 'firestore', reason: 'r', fixedBy: 'f', gap: { kind: 'unverified-row', rowId: 'x' } },
      },
    ]);
    expect(entryPathGateExitCode(report)).toBe(0);
  });

  test('an uncited red program is fatal — the CLIFF, no tolerance', () => {
    const report = reportOf([
      { program: 'auth', verdict: 'green' },
      { program: 'firestore', verdict: 'red', error: 'boom' },
    ]);
    expect(entryPathGateExitCode(report)).toBe(1);
  });

  test('a stale expected-failure (program actually passed) is fatal', () => {
    const report = reportOf([
      {
        program: 'auth',
        verdict: 'stale-expected-failure',
        expectedFailure: { program: 'auth', reason: 'r', fixedBy: 'f', gap: { kind: 'unverified-row', rowId: 'x' } },
      },
    ]);
    expect(entryPathGateExitCode(report)).toBe(1);
  });

  test('an expected-failure citing an unknown program is fatal even if every real program is green', () => {
    const report = reportOf([{ program: 'auth', verdict: 'green' }], ['not-a-real-program']);
    expect(entryPathGateExitCode(report)).toBe(1);
  });
});

describe('runEntryPathGate — real corpus, in-process', () => {
  test('runs every entry-path/<name>.ts program and exits clean today (green or red-known-with-citation)', async () => {
    const report = await runEntryPathGate();
    expect(report.results.length).toBeGreaterThan(0);
    expect(entryPathGateExitCode(report)).toBe(0);
    // No program may be silently RED or STALE in the committed corpus.
    for (const result of report.results) {
      expect(['green', 'red-known']).toContain(result.verdict);
    }
  });

  test('covers all four services named in the mission corpus', async () => {
    const report = await runEntryPathGate();
    const names = report.results.map((r) => r.program).sort();
    expect(names).toEqual(['auth', 'database', 'firestore', 'storage']);
  });
});
