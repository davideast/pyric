import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTarget, readKeptRun, reproTargets, slugOf, type KeptRun } from './repro-target.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');
const builderReport = () => JSON.parse(readFileSync(join(FIXTURES, 'report-valid.json'), 'utf8')) as unknown;

function keptRun(overrides: { builder?: unknown; automaticProblems?: unknown[] } = {}): unknown {
  return {
    builder: 'builder' in overrides ? overrides.builder : builderReport(),
    harness: {
      run: 'r1-1-haiku-5-5',
      round: 'r1',
      provenance: { commit: 'abc', dirty: false, tarballs: { '@pyric/cli': 'f'.repeat(64) } },
      automaticProblems: overrides.automaticProblems ?? [
        { kind: 'refusal-allowed', action: "another user's write under the given rules", firebaseDoc: 'https://firebase.google.com/docs/storage', productionAnswer: 'storage/unauthorized', pyricAnswer: 'allowed' },
        { kind: 'google-host', host: 'firestore.googleapis.com', catalogGap: false, metadata: false, layers: ['node'], events: 2 },
      ],
    },
  };
}

function read(value: unknown): KeptRun {
  const dir = mkdtempSync(join(tmpdir(), 'repro-target-'));
  const file = join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(value));
  const parsed = readKeptRun(file);
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.value;
}

describe('reproTargets', () => {
  test('names each builder problem, each allowed refusal and each Google host', () => {
    const targets = reproTargets(read(keptRun()));
    expect(targets.map((target) => `${target.kind} ${target.selector} ${target.slug}`)).toEqual([
      'builder-problem p1 p1',
      'refusal-allowed refusal-allowed-1 refusal-allowed-1',
      'google-host google-host:firestore.googleapis.com google-host-firestore-googleapis-com',
    ]);
  });

  test('a run with no builder report still has the harness\'s problems', () => {
    expect(reproTargets(read(keptRun({ builder: null }))).map((target) => target.selector)).toEqual(['refusal-allowed-1', 'google-host:firestore.googleapis.com']);
  });

  test('gives ids that slug alike a slug each', () => {
    const report = builderReport() as { problems: Record<string, unknown>[] };
    const first = report.problems[0] ?? {};
    report.problems = [{ ...first, id: 'A b' }, { ...first, id: 'a-b' }, { ...first, id: 'a/b' }];
    expect(reproTargets(read(keptRun({ builder: report, automaticProblems: [] }))).map((target) => target.slug)).toEqual(['a-b', 'a-b-2', 'a-b-3']);
  });
});

describe('slugOf', () => {
  test('never leaves a dot, a slash or an empty name', () => {
    expect(slugOf('../../etc/passwd')).toBe('etc-passwd');
    expect(slugOf('..')).toBe('problem');
    expect(slugOf('/')).toBe('problem');
    expect(slugOf('x'.repeat(200))).toHaveLength(60);
  });
});

describe('findTarget', () => {
  test('finds a target by its selector, or lists the run\'s selectors', () => {
    const run = read(keptRun());
    expect(findTarget(run, 'google-host:firestore.googleapis.com').target?.kind).toBe('google-host');
    expect(findTarget(run, 'p2').error).toBe('run r1-1-haiku-5-5 has no problem "p2"; its problems: p1, refusal-allowed-1, google-host:firestore.googleapis.com');
  });
});

describe('readKeptRun', () => {
  test('refuses a record without the harness\'s provenance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repro-target-'));
    const file = join(dir, 'report.json');
    writeFileSync(file, JSON.stringify({ builder: null, harness: { run: 'x', round: 'r1', automaticProblems: [] } }));
    expect(readKeptRun(file).ok).toBe(false);
    expect(readKeptRun(join(dir, 'none.json'))).toEqual({ ok: false, errors: [`no kept run record ${join(dir, 'none.json')}`] });
  });
});
