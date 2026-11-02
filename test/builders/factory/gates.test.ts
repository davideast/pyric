// How the hourly check's gates add up, the layout baseline, and what a pass
// does to the served copy.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeGates, GATES, skipped, type GateResult } from './gates.ts';
import { readLastGood, serveAction, writeLastGood, type LastGood } from './last-good.ts';
import { newLayoutProblems } from './layout-gate.ts';
import { parseChangedLines } from './diff-lines.ts';
import type { PageCapture } from './walk-runner.ts';

const pass = (gate: GateResult['gate']): GateResult => ({ gate, passed: true, summary: 'passed' });

describe('composeGates', () => {
  test('passes only when every gate ran and passed', () => {
    expect(composeGates(GATES.map(pass)).passed).toBe(true);
    expect(composeGates(GATES.map(pass)).summary).toBe('all 8 gates passed');
  });

  test('a failing gate fails the check and is named with its line', () => {
    const results = GATES.map((gate) => (gate === 'copy' ? { gate, passed: false, summary: '2 of 5 new strings fail' } : pass(gate)));
    const composed = composeGates(results);
    expect(composed.passed).toBe(false);
    expect(composed.failed).toEqual(['copy']);
    expect(composed.summary).toBe('1 of 8 gates failed: copy (2 of 5 new strings fail)');
  });

  test('a gate that did not run fails it too, skipped or missing', () => {
    const results = GATES.filter((gate) => gate !== 'layout').map((gate) => (gate === 'walks' ? skipped('walks', 'Studio did not start') : pass(gate)));
    const composed = composeGates(results);
    expect(composed.failed).toEqual(['walks', 'layout']);
    expect(composed.summary).toContain('walks (did not run: Studio did not start)');
    expect(composed.summary).toContain('layout (did not run)');
  });
});

describe('newLayoutProblems', () => {
  const page = (path: string, width: number, keys: string[], error?: string): PageCapture => ({
    path, width, screenshot: 'x.png', findings: keys.map((key) => ({ rule: 'clipped-text', key, detail: `${key} clipped` })), ...(error === undefined ? {} : { error }),
  });

  test('a finding the start commit already had at that width is not new', () => {
    const before = [page('/library', 1440, ['p.title']), page('/library', 390, [])];
    const after = [page('/library', 1440, ['p.title', 'span.new']), page('/library', 390, ['p.title'])];
    const problems = newLayoutProblems(after, before);
    expect(problems.map((problem) => `${problem.width} ${problem.detail}`)).toEqual(['1440 span.new clipped', '390 p.title clipped']);
  });

  test('a page the start commit never had counts in full, and a failed capture counts', () => {
    const problems = newLayoutProblems([page('/new', 1440, ['div.a']), page('/settings', 390, [], 'timeout')], []);
    expect(problems.map((problem) => problem.rule)).toEqual(['clipped-text', 'capture-failed']);
  });
});

describe('serveAction', () => {
  const previous: LastGood = { commit: 'aaa', hour: 1, at: '2026-11-02T01:00:00.000Z' };

  test('a failing hour leaves the served copy alone, serving or not', () => {
    expect(serveAction({ previous, passed: false, commit: 'bbb', serving: true })).toBe('leave');
    expect(serveAction({ previous, passed: false, commit: 'bbb', serving: false })).toBe('leave');
  });

  test('a passing hour restarts it for a new commit, the first one included', () => {
    expect(serveAction({ previous, passed: true, commit: 'bbb', serving: true })).toBe('restart');
    expect(serveAction({ previous: undefined, passed: true, commit: 'aaa', serving: false })).toBe('restart');
  });

  test('a passing hour on the served commit leaves it, or starts it when nothing serves', () => {
    expect(serveAction({ previous, passed: true, commit: 'aaa', serving: true })).toBe('leave');
    expect(serveAction({ previous, passed: true, commit: 'aaa', serving: false })).toBe('start');
  });

  test('last-good.json reads back what was written', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'factory-last-good-')), 'last-good.json');
    expect(readLastGood(file)).toBeUndefined();
    writeLastGood(file, previous);
    expect(readLastGood(file)).toEqual(previous);
  });
});

describe('parseChangedLines', () => {
  test('reads the new side of each hunk, and a hunk of zero lines adds none', () => {
    const diff = [
      'diff --git a/studio/a.tsx b/studio/a.tsx',
      '--- a/studio/a.tsx',
      '+++ b/studio/a.tsx',
      '@@ -3 +3,2 @@',
      '@@ -10,2 +11 @@',
      '@@ -20,3 +20,0 @@',
      'diff --git a/studio/b.css b/studio/b.css',
      '--- /dev/null',
      '+++ b/studio/b.css',
      '@@ -0,0 +1,3 @@',
    ].join('\n');
    const changed = parseChangedLines(diff);
    expect([...(changed.get('studio/a.tsx') ?? [])]).toEqual([3, 4, 11]);
    expect([...(changed.get('studio/b.css') ?? [])]).toEqual([1, 2, 3]);
  });
});
