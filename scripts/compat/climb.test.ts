/**
 * Unit coverage for the climb lane's pure core (scripts/compat/climb.ts). These
 * guard the two behaviors that cannot be exercised until rows begin to flip:
 * the regression rule (cdd.md Step 5.5 / Step 6) and the row-id boundary
 * matching that keeps `messaging#1` from being mistaken for `messaging#12`.
 *
 * Not part of the blocking `npm test` run (which globs the package suites, not
 * scripts/compat). Run explicitly: `bun test scripts/compat/climb.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { classifyRows, mentionsRow, parseJUnit, type RowInput, type TestCase } from './climb.ts';

describe('mentionsRow — row-id boundary matching', () => {
  test('a row id matches its own name', () => {
    expect(mentionsRow('messaging#2 — getToken', 'messaging#2')).toBe(true);
  });

  test('a shorter id does not match a longer numeric sibling', () => {
    expect(mentionsRow('messaging#12 — send', 'messaging#1')).toBe(false);
    expect(mentionsRow('messaging#17', 'messaging#1')).toBe(false);
  });

  test('a client id does not match the admin surface with the same ref', () => {
    expect(mentionsRow('messaging-admin#4 topic', 'messaging#4')).toBe(false);
  });

  test('nested describes (JUnit joins them with " > ") still map', () => {
    expect(mentionsRow('accept paths > messaging-admin#4', 'messaging-admin#4')).toBe(true);
  });
});

describe('parseJUnit', () => {
  const xml = `<testsuites>
    <testcase name="a" classname="messaging#2" />
    <testcase name="b" classname="messaging#4"><failure type="AssertionError"/></testcase>
    <testcase name="c" classname="messaging-admin#4"><error/></testcase>
  </testsuites>`;
  const cases = parseJUnit(xml);

  test('reads every testcase', () => {
    expect(cases.length).toBe(3);
  });

  test('self-closing testcase is a pass; <failure>/<error> child is a fail', () => {
    expect(cases[0].passed).toBe(true);
    expect(cases[1].passed).toBe(false);
    expect(cases[2].passed).toBe(false);
  });
});

describe('classifyRows — the regression rule', () => {
  const rows: RowInput[] = [
    { id: 'messaging#2', status: 'conforms' }, // passes -> green
    { id: 'messaging#4', status: 'unverified' }, // fails  -> red, but expected
    { id: 'messaging#8', status: 'conforms' }, // fails   -> REGRESSION
    { id: 'messaging#9', status: 'diverged-documented' }, // fails -> REGRESSION (Step 6)
    { id: 'messaging#10', status: 'conforms' }, // no assertion set -> unguarded
    { id: 'messaging#11', status: 'unverified' }, // passes -> flip candidate
  ];
  const testcases: TestCase[] = [
    { classname: 'messaging#2', name: 'ok', passed: true },
    { classname: 'messaging#4', name: 'red', passed: false },
    { classname: 'messaging#8', name: 'boom', passed: false },
    { classname: 'messaging#9', name: 'pin broke', passed: false },
    { classname: 'messaging#11', name: 'passes early', passed: true },
    { classname: 'completeness gate', name: 'covers rows', passed: false }, // unkeyed
  ];
  const c = classifyRows(rows, testcases);

  test('gates on conforms AND diverged-documented rows gone red, and nothing else', () => {
    expect(c.regressions.map((r) => r.id).sort()).toEqual(['messaging#8', 'messaging#9']);
  });

  test('a failing unverified row is the expected red, never a regression', () => {
    expect(c.regressions.some((r) => r.id === 'messaging#4')).toBe(false);
  });

  test('a conforms row with no assertion set is unguarded, not a regression', () => {
    expect(c.unguarded.map((r) => r.id)).toEqual(['messaging#10']);
    expect(c.regressions.some((r) => r.id === 'messaging#10')).toBe(false);
  });

  test('a passing not-yet-flipped row is a flip candidate', () => {
    expect(c.flipCandidates.map((r) => r.id)).toEqual(['messaging#11']);
  });

  test('an unkeyed failing test (completeness gate) never gates', () => {
    expect(c.unkeyedTests).toBe(1);
    expect(c.unkeyedFailures).toBe(1);
    expect(c.regressions.length).toBe(2);
  });

  test('verdict tallies', () => {
    expect(c.greenRows).toBe(2); // #2, #11
    expect(c.redRows).toBe(3); // #4, #8, #9
    expect(c.unmappedRows).toBe(1); // #10
  });
});

describe('classifyRows — red at birth', () => {
  test('an all-unverified suite full of reds produces zero regressions', () => {
    const c = classifyRows(
      [
        { id: 'messaging#1', status: 'unverified' },
        { id: 'messaging#2', status: 'unverified' },
      ],
      [
        { classname: 'messaging#1', name: 'x', passed: false },
        { classname: 'messaging#2', name: 'y', passed: false },
      ],
    );
    expect(c.regressions).toEqual([]);
  });
});
