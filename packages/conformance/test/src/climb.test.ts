/**
 * Unit coverage for the climb lane's pure core (packages/conformance/src/climb.ts). These
 * guard the behaviors that cannot be exercised until rows begin to flip:
 * the regression rule (cdd.md Step 5.5 / Step 6), skipped-test handling (#1192),
 * and the row-id boundary matching that keeps `messaging#1` from being mistaken
 * for `messaging#12`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { renderClimbJson } from '../../src/climb-report.ts';
import { classifyRows, mentionsRow, parseJUnit, type RowInput, type TestCase } from '../../src/climb.ts';

function unlinkIfPresent(filePath: string): void {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

describe('mentionsRow -- row-id boundary matching', () => {
  test('a row id matches its own name', () => {
    expect(mentionsRow('messaging#2 -- getToken', 'messaging#2')).toBe(true);
  });

  test('a shorter id does not match a longer numeric sibling', () => {
    expect(mentionsRow('messaging#12 -- send', 'messaging#1')).toBe(false);
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
    <testcase name="d" classname="messaging#5"><skipped/></testcase>
    <testcase name="e" classname="messaging#6"><skipped message="pending"/></testcase>
    <testcase name="f" classname="messaging#7" status="skipped" />
  </testsuites>`;
  const cases = parseJUnit(xml);

  test('reads every testcase', () => {
    expect(cases.length).toBe(6);
  });

  test('self-closing testcase is a pass; <failure>/<error> child is a fail', () => {
    expect(cases[0]?.passed).toBe(true);
    expect(cases[0]?.skipped).toBe(false);
    expect(cases[1]?.passed).toBe(false);
    expect(cases[1]?.skipped).toBe(false);
    expect(cases[2]?.passed).toBe(false);
    expect(cases[2]?.skipped).toBe(false);
  });

  test('<skipped> child or status="skipped" attribute sets skipped: true and passed: false', () => {
    expect(cases[3]?.passed).toBe(false);
    expect(cases[3]?.skipped).toBe(true);
    expect(cases[4]?.passed).toBe(false);
    expect(cases[4]?.skipped).toBe(true);
    expect(cases[5]?.passed).toBe(false);
    expect(cases[5]?.skipped).toBe(true);
  });
});

describe('classifyRows -- the regression rule', () => {
  const rows: RowInput[] = [
    { id: 'messaging#2', status: 'conforms' }, // passes -> green
    { id: 'messaging#4', status: 'unverified' }, // fails  -> red, but expected
    { id: 'messaging#8', status: 'conforms' }, // fails   -> REGRESSION
    { id: 'messaging#9', status: 'diverged-documented' }, // fails -> REGRESSION (Step 6)
    { id: 'messaging#10', status: 'conforms' }, // no assertion set -> unguarded
    { id: 'messaging#11', status: 'unverified' }, // passes -> flip candidate
    { id: 'messaging#12', status: 'unsupported', conformanceDisposition: 'held' }, // passes -> reviewed hold
    { id: 'messaging#13', status: 'unsupported' }, // passes -> never a flip candidate
  ];
  const testcases: TestCase[] = [
    { classname: 'messaging#2', name: 'ok', passed: true },
    { classname: 'messaging#4', name: 'red', passed: false },
    { classname: 'messaging#8', name: 'boom', passed: false },
    { classname: 'messaging#9', name: 'pin broke', passed: false },
    { classname: 'messaging#11', name: 'passes early', passed: true },
    { classname: 'messaging#12', name: 'held behavior is pinned', passed: true },
    { classname: 'messaging#13', name: 'unsupported behavior is pinned', passed: true },
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

  test('a passing reviewed hold is not proposed for promotion', () => {
    expect(c.flipCandidates.some((r) => r.id === 'messaging#12')).toBe(false);
    expect(c.flipCandidates.some((r) => r.id === 'messaging#13')).toBe(false);
  });

  test('an unkeyed failing test (completeness gate) never gates', () => {
    expect(c.unkeyedTests).toBe(1);
    expect(c.unkeyedFailures).toBe(1);
    expect(c.regressions.length).toBe(2);
  });

  test('verdict tallies', () => {
    expect(c.greenRows).toBe(4); // #2, #11, #12, #13
    expect(c.redRows).toBe(3); // #4, #8, #9
    expect(c.skippedRows).toBe(0);
    expect(c.unmappedRows).toBe(1); // #10
  });
});

describe('classifyRows -- skipped rows (#1192)', () => {
  const rows: RowInput[] = [
    { id: 'messaging#1', status: 'conforms' }, // passes -> green
    { id: 'messaging#2', status: 'unverified' }, // skipped -> skipped, NOT green, NOT flip candidate
    { id: 'messaging#3', status: 'unverified' }, // 1 pass + 1 skip -> skipped, NOT green
    { id: 'messaging#4', status: 'conforms' }, // skipped -> REGRESSION
    { id: 'messaging#5', status: 'diverged-documented' }, // skipped -> REGRESSION
    { id: 'messaging#6', status: 'conforms' }, // 1 fail + 1 skip -> red REGRESSION
  ];
  const testcases: TestCase[] = [
    { classname: 'messaging#1', name: 'live pass', passed: true, skipped: false },
    { classname: 'messaging#2', name: 'todo', passed: false, skipped: true },
    { classname: 'messaging#3', name: 'first check', passed: true, skipped: false },
    { classname: 'messaging#3', name: 'second check skipped', passed: false, skipped: true },
    { classname: 'messaging#4', name: 'disabled conforms test', passed: false, skipped: true },
    { classname: 'messaging#5', name: 'disabled pin', passed: false, skipped: true },
    { classname: 'messaging#6', name: 'broke', passed: false, skipped: false },
    { classname: 'messaging#6', name: 'also skipped', passed: false, skipped: true },
    { classname: 'unkeyed helper', name: 'skipped helper', passed: false, skipped: true },
  ];
  const c = classifyRows(rows, testcases);

  test('skipped rows are never counted as green or proposed as flip candidates', () => {
    expect(c.greenRows).toBe(1);
    expect(c.skippedRows).toBe(4); // #2, #3, #4, #5
    expect(c.redRows).toBe(1); // #6
    expect(c.flipCandidates).toEqual([]);
  });

  test('expected-green rows whose assertion sets are skipped fail the regression gate', () => {
    expect(c.regressions.map((r) => r.id).sort()).toEqual([
      'messaging#4',
      'messaging#5',
      'messaging#6',
    ]);
    const row4 = c.rows.find((r) => r.id === 'messaging#4');
    expect(row4?.verdict).toBe('skipped');
    expect(row4?.regressed).toBe(true);
  });

  test('skipped unverified rows and unkeyed skipped tests do not trigger regressions', () => {
    expect(c.regressions.some((r) => r.id === 'messaging#2')).toBe(false);
    expect(c.regressions.some((r) => r.id === 'messaging#3')).toBe(false);
    expect(c.unkeyedTests).toBe(1);
    expect(c.unkeyedFailures).toBe(0);
    expect(c.unkeyedSkipped).toBe(1);
  });
});

describe('classifyRows -- red at birth', () => {
  test('an all-unverified suite full of reds and skips produces zero regressions', () => {
    const c = classifyRows(
      [
        { id: 'messaging#1', status: 'unverified' },
        { id: 'messaging#2', status: 'unverified' },
      ],
      [
        { classname: 'messaging#1', name: 'x', passed: false },
        { classname: 'messaging#2', name: 'y', passed: false, skipped: true },
      ],
    );
    expect(c.regressions).toEqual([]);
    expect(c.greenRows).toBe(0);
    expect(c.skippedRows).toBe(1);
  });
});

describe('real bun test JUnit skipped-row round-trip (#1192)', () => {
  test('bun test --reporter=junit marks test.skip, describe.skip, and test.todo as skipped', () => {
    const scratchDir = join(homedir(), '.cache', 'pyric-tmp');
    mkdirSync(scratchDir, { recursive: true });
    const fixtureFile = join(scratchDir, `climb-skip-fixture-${process.pid}.test.ts`);
    const xmlFile = join(scratchDir, `climb-skip-fixture-${process.pid}.xml`);
    unlinkIfPresent(fixtureFile);
    unlinkIfPresent(xmlFile);

    try {
      writeFileSync(
        fixtureFile,
        [
          "import { describe, expect, test } from 'bun:test';",
          "describe('messaging#1', () => { test('live pass', () => { expect(1).toBe(1); }); });",
          "describe('messaging#2', () => { test.skip('skipped unverified', () => { expect(1).toBe(2); }); });",
          "describe.skip('messaging#3', () => { test('skipped conforms block', () => { expect(1).toBe(1); }); });",
          "describe('messaging#4', () => { test.todo('todo unverified'); });",
        ].join('\n'),
        'utf8',
      );

      const proc = spawnSync(
        process.execPath,
        ['test', fixtureFile, '--reporter=junit', `--reporter-outfile=${xmlFile}`],
        { encoding: 'utf8' },
      );
      expect(proc.status).toBe(0);
      expect(existsSync(xmlFile)).toBe(true);

      const parsed = parseJUnit(readFileSync(xmlFile, 'utf8'));
      expect(parsed.length).toBe(4);

      const rows: RowInput[] = [
        { id: 'messaging#1', status: 'conforms' },
        { id: 'messaging#2', status: 'unverified' },
        { id: 'messaging#3', status: 'conforms' },
        { id: 'messaging#4', status: 'unverified' },
      ];
      const classified = classifyRows(rows, parsed);
      expect(classified.greenRows).toBe(1);
      expect(classified.skippedRows).toBe(3);
      expect(classified.flipCandidates).toEqual([]);
      expect(classified.regressions.map((r) => r.id)).toEqual(['messaging#3']);

      const json = JSON.parse(
        renderClimbJson(
          [
            {
              surface: 'messaging',
              suite: fixtureFile,
              suiteOutcome: 'ran',
              totalRows: 4,
              conformingRows: 2,
              expectedGreenRows: 2,
              greenRows: classified.greenRows,
              redRows: classified.redRows,
              skippedRows: classified.skippedRows,
              unmappedRows: classified.unmappedRows,
              testsTotal: parsed.length,
              testsPassed: parsed.filter((t) => t.passed && !t.skipped).length,
              testsFailed: parsed.filter((t) => !t.passed && !t.skipped).length,
              testsSkipped: parsed.filter((t) => t.skipped === true).length,
              unkeyedTests: classified.unkeyedTests,
              unkeyedFailures: classified.unkeyedFailures,
              unkeyedSkipped: classified.unkeyedSkipped,
              rows: classified.rows,
              regressions: classified.regressions,
              unguarded: classified.unguarded,
              flipCandidates: classified.flipCandidates,
              overclaims: true,
            },
          ],
          1,
          ['conforms', 'diverged-documented'],
        ),
      ) as { surfaces: Array<{ greenRows: number; skippedRows: number; tests: { passed: number; skipped: number } }> };

      expect(json.surfaces[0]?.greenRows).toBe(1);
      expect(json.surfaces[0]?.skippedRows).toBe(3);
      expect(json.surfaces[0]?.tests.passed).toBe(1);
      expect(json.surfaces[0]?.tests.skipped).toBe(3);
    } finally {
      unlinkIfPresent(fixtureFile);
      unlinkIfPresent(xmlFile);
    }
  });
});
