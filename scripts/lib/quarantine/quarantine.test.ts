import { describe, expect, test } from 'bun:test';
import { appVerdict } from './apps.ts';
import { addDays, entryFileName, isActive, matches, type LoadedEntry, type TestResult } from './entries.ts';
import { consoleTotals, parseJunit } from './junit.ts';
import { RELEASE_STREAK, decideComments, streak, type RunReports } from './release.ts';
import { annotations, consoleLines, toReport, type QuarantineReport } from './report.ts';
import { validateEntry } from './validate.ts';
import { decide, type RunEvidence } from './verdict.ts';

const TODAY = '2026-10-29';
const FILE = 'packages/cli/test/serve/hosted-sqlite.test.ts';
const NAMED = `${FILE} > peer liveness > closes a silent socket`;

function entry(test: string, overrides: Partial<LoadedEntry> = {}): LoadedEntry {
  return {
    test, issue: 1477, owner: 'agent on #1477', reason: 'hits its 30 s limit under load',
    added: TODAY, expires: addDays(TODAY, 14), renewals: [], file: entryFileName(test), ...overrides,
  };
}

function result(id: string, outcome: TestResult['outcome'] = 'failed'): TestResult {
  return { id, file: id.split(' > ')[0] ?? id, outcome };
}

function evidence(results: TestResult[] | undefined, overrides: Partial<RunEvidence> = {}): RunEvidence {
  const fail = (results ?? []).filter((item) => item.outcome === 'failed').length;
  return { exitCode: 1, results, totals: { fail, errors: 0 }, ...overrides };
}

// From bun 1.3.11: `bun test --reporter=junit` on a nested describe, a hook
// timeout, a broken beforeAll and a skip.
const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" assertions="1" failures="3" skipped="1" time="0.04">
  <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="4" failures="2" skipped="1">
    <testsuite name="outer" file="test/a.test.ts" line="2">
      <testsuite name="inner &amp; more" file="test/a.test.ts" line="2">
        <testcase name="fails" classname="inner &amp;gt; outer" file="test/a.test.ts" line="2">
          <failure type="AssertionError" />
        </testcase>
      </testsuite>
      <testcase name="passes" classname="outer" file="test/a.test.ts" line="2" />
    </testsuite>
    <testcase name="skipped" classname="" file="test/a.test.ts" line="4">
      <skipped />
    </testcase>
  </testsuite>
  <testsuite name="test/d.test.ts" file="test/d.test.ts" tests="1" failures="1">
    <testsuite name="broken all" file="test/d.test.ts" line="6">
      <testcase name="(unnamed)" classname="broken all" file="test/d.test.ts">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>`;

describe('reading bun JUnit and console totals', () => {
  test('names each test as the console does, from the nested suites, under the repo path', () => {
    expect(parseJunit(JUNIT, 'packages/cli')).toEqual([
      { id: 'packages/cli/test/a.test.ts > outer > inner & more > fails', file: 'packages/cli/test/a.test.ts', outcome: 'failed' },
      { id: 'packages/cli/test/a.test.ts > outer > passes', file: 'packages/cli/test/a.test.ts', outcome: 'passed' },
      { id: 'packages/cli/test/a.test.ts > skipped', file: 'packages/cli/test/a.test.ts', outcome: 'skipped' },
      { id: 'packages/cli/test/d.test.ts > broken all > (unnamed)', file: 'packages/cli/test/d.test.ts', outcome: 'failed' },
    ]);
  });

  test('refuses a file that is not JUnit', () => {
    expect(() => parseJunit('not xml', '')).toThrow('not a JUnit file');
  });

  test('reads the last fail and error totals, with colour codes', () => {
    expect(consoleTotals(' 1 pass\n 1 skip\n \u001b[31m4 fail\u001b[0m\n 1 error\n')).toEqual({ fail: 4, errors: 1 });
    expect(consoleTotals(' 3 pass\n 0 fail\n')).toEqual({ fail: 0, errors: 0 });
    expect(consoleTotals('no totals')).toEqual({ errors: 0 });
  });
});

describe('matching an entry', () => {
  test('a named entry matches only its own test', () => {
    expect(matches(entry(NAMED), result(NAMED))).toBe(true);
    expect(matches(entry(NAMED), result(`${FILE} > peer liveness > another`))).toBe(false);
  });

  test('a file entry matches only the file\'s unnamed failures, never a named test in it', () => {
    const fileEntry = entry(FILE);
    expect(matches(fileEntry, result(`${FILE} > (unnamed)`))).toBe(true);
    expect(matches(fileEntry, result(`${FILE} > hooks > (unnamed)`))).toBe(true);
    expect(matches(fileEntry, result(NAMED))).toBe(false);
    expect(matches(fileEntry, result('packages/cli/test/other.test.ts > (unnamed)'))).toBe(false);
  });

  test('an entry is active through the day it expires', () => {
    expect(isActive(entry(NAMED), addDays(TODAY, 14))).toBe(true);
    expect(isActive(entry(NAMED), addDays(TODAY, 15))).toBe(false);
  });
});

describe('the verdict', () => {
  const quarantined = [entry(NAMED)];

  test('a run whose only failures are quarantined ends with exit code 0', () => {
    const verdict = decide(evidence([result(NAMED), result(`${FILE} > other`, 'passed')]), quarantined, TODAY);
    expect(verdict).toMatchObject({ exitCode: 0, forgiven: true });
    expect(verdict.quarantined.map((match) => match.result.id)).toEqual([NAMED]);
    expect(verdict.outcomes.map((outcome) => outcome.outcome)).toEqual(['failed']);
  });

  // Each condition that keeps the run's own exit code.
  test('an exit code other than 1 stands', () => {
    expect(decide(evidence([result(NAMED)], { exitCode: 2 }), quarantined, TODAY)).toMatchObject({ exitCode: 2, forgiven: false });
    expect(decide(evidence([result(NAMED)], { exitCode: null }), quarantined, TODAY)).toMatchObject({ exitCode: 1, forgiven: false });
  });

  test('a missing or unreadable JUnit file keeps exit code 1', () => {
    expect(decide(evidence(undefined, { totals: { fail: 1, errors: 0 } }), quarantined, TODAY))
      .toMatchObject({ exitCode: 1, forgiven: false, reason: 'the JUnit file is missing or did not parse' });
  });

  test('a JUnit file with no failing test keeps exit code 1', () => {
    expect(decide(evidence([result(NAMED, 'passed')], { totals: { fail: 0, errors: 0 } }), quarantined, TODAY))
      .toMatchObject({ exitCode: 1, forgiven: false, reason: 'the JUnit file names no failing test' });
  });

  test('a console fail total that differs from the JUnit count keeps exit code 1', () => {
    // A file that fails to load counts in the console total but not in JUnit.
    expect(decide(evidence([result(NAMED)], { totals: { fail: 2, errors: 0 } }), quarantined, TODAY))
      .toMatchObject({ exitCode: 1, forgiven: false });
    expect(decide(evidence([result(NAMED)], { totals: { errors: 0 } }), quarantined, TODAY))
      .toMatchObject({ exitCode: 1, forgiven: false });
  });

  test('an error outside a test keeps exit code 1', () => {
    expect(decide(evidence([result(NAMED)], { totals: { fail: 1, errors: 1 } }), quarantined, TODAY))
      .toMatchObject({ exitCode: 1, forgiven: false, reason: 'bun reported 1 error(s) outside a test' });
  });

  test('a failure no entry covers keeps exit code 1, alongside a quarantined one', () => {
    const verdict = decide(evidence([result(NAMED), result(`${FILE} > other`)]), quarantined, TODAY);
    expect(verdict).toMatchObject({ exitCode: 1, forgiven: false, reason: '1 failing test(s) are not quarantined' });
    expect(verdict.quarantined).toHaveLength(1);
  });

  test('an expired entry forgives nothing and is reported as blocking', () => {
    const expired = [entry(NAMED, { added: '2026-10-01', expires: '2026-10-15' })];
    const verdict = decide(evidence([result(NAMED)]), expired, TODAY);
    expect(verdict).toMatchObject({ exitCode: 1, forgiven: false });
    expect(verdict.expired.map((match) => match.entry.test)).toEqual([NAMED]);
    expect(consoleLines(verdict)[0]).toContain('expired 2026-10-15');
  });

  test('a passing run reports each entry\'s result and keeps exit code 0', () => {
    const verdict = decide(evidence([result(NAMED, 'passed')], { exitCode: 0 }), [...quarantined, entry(FILE)], TODAY);
    expect(verdict).toMatchObject({ exitCode: 0, forgiven: false });
    expect(verdict.outcomes.map((outcome) => outcome.outcome)).toEqual(['passed', 'passed']);
  });

  test('an entry for a test the run did not include is not-run', () => {
    const verdict = decide(evidence([result('packages/pyric/x.test.ts > y', 'passed')], { exitCode: 0 }), quarantined, TODAY);
    expect(verdict.outcomes[0]?.outcome).toBe('not-run');
  });

  test('a quarantined failure is announced as a warning annotation', () => {
    const verdict = decide(evidence([result(NAMED)]), quarantined, TODAY);
    expect(annotations(verdict)).toEqual([`::warning title=Quarantined test failed::${NAMED} (#1477, quarantined until 2026-11-12)`]);
  });
});

describe('app scenarios', () => {
  const app = entry('test/apps/ai-sandbox-contents-roles', { issue: 1616 });

  test('a run whose only failed app is quarantined ends with exit code 0', () => {
    const apps = [{ name: 'ai-sandbox-contents-roles', ok: false }, { name: 'node-client', ok: true }];
    expect(appVerdict({ apps, exitCode: 1 }, [app], TODAY)).toMatchObject({ exitCode: 0, forgiven: true });
  });

  test('another failed app keeps exit code 1', () => {
    const apps = [{ name: 'ai-sandbox-contents-roles', ok: false }, { name: 'node-client', ok: false }];
    expect(appVerdict({ apps, exitCode: 1 }, [app], TODAY)).toMatchObject({ exitCode: 1, forgiven: false });
  });
});

describe('checking an entry', () => {
  const exists = () => true;

  test('a named test in a covered suite passes', () => {
    expect(validateEntry(entry(NAMED), entryFileName(NAMED), exists)).toEqual([]);
  });

  test('a test outside the covered suites is refused, since no runner would honour it', () => {
    const outside = 'packages/pyric-admin/test/a.test.ts > b';
    expect(validateEntry(entry(outside), entryFileName(outside), exists).join()).toContain('not in a suite the quarantine covers');
  });

  test('an unnamed failure is quarantined by its file alone, not by a `(unnamed)` name', () => {
    const unnamed = `${FILE} > (unnamed)`;
    expect(validateEntry(entry(unnamed), entryFileName(unnamed), exists).join()).toContain(`name the file alone (${FILE})`);
    expect(validateEntry(entry(FILE), entryFileName(FILE), exists)).toEqual([]);
  });

  test('a file that does not exist, a non-test file, and a wrong file name are refused', () => {
    expect(validateEntry(entry(NAMED), entryFileName(NAMED), () => false).join()).toContain('does not exist');
    expect(validateEntry(entry('packages/cli/src/a.ts'), entryFileName('packages/cli/src/a.ts'), exists).join()).toContain('is not a test file');
    expect(validateEntry(entry(NAMED), 'other.json', exists).join()).toContain(`must be named ${entryFileName(NAMED)}`);
  });

  test('an app entry needs the app\'s scenario.ts', () => {
    const app = 'test/apps/node-client';
    expect(validateEntry(entry(app), entryFileName(app), exists)).toEqual([]);
    expect(validateEntry(entry(app), entryFileName(app), () => false).join()).toContain('scenario.ts does not exist');
  });

  test('a quarantine longer than 14 days is refused, added or renewed', () => {
    expect(validateEntry(entry(NAMED, { expires: addDays(TODAY, 15) }), entryFileName(NAMED), exists).join()).toContain('more than 14 days');
    const renewal = { date: '2026-11-12', expires: '2026-11-27', reason: 'fix in review' };
    const renewed = entry(NAMED, { renewals: [renewal], expires: renewal.expires });
    expect(validateEntry(renewed, entryFileName(NAMED), exists).join()).toContain('lasts more than 14 days');
  });

  test('a renewal needs a reason and moves expires', () => {
    const renewal = { date: '2026-11-12', expires: '2026-11-26', reason: ' ' };
    expect(validateEntry(entry(NAMED, { renewals: [renewal], expires: renewal.expires }), entryFileName(NAMED), exists).join()).toContain('needs a reason');
    const kept = { ...renewal, reason: 'fix in review' };
    expect(validateEntry(entry(NAMED, { renewals: [kept] }), entryFileName(NAMED), exists).join()).toContain('must equal the last renewal');
    expect(validateEntry(entry(NAMED, { renewals: [kept], expires: kept.expires }), entryFileName(NAMED), exists)).toEqual([]);
  });

  test('a missing field is refused', () => {
    expect(validateEntry({ test: NAMED }, entryFileName(NAMED), exists)).toContain('issue must be a positive integer');
  });
});

describe('release check comments', () => {
  const quarantinedEntry = entry(NAMED);

  function run(runId: number, outcome: string): RunReports {
    const report: QuarantineReport = {
      suite: 'cli-1', forgiven: false, reason: 'the run passed', expired: [],
      entries: [{ file: quarantinedEntry.file, test: NAMED, issue: 1477, expires: quarantinedEntry.expires, outcome }],
    };
    return { runId, url: `https://example.test/runs/${runId}`, reports: [report] };
  }

  function history(runs: RunReports[]): (index: number) => RunReports | undefined {
    return (index) => runs[index];
  }

  test('a failure in the run just completed is commented on the tracking issue once', () => {
    const input = { entries: [quarantinedEntry], today: TODAY, history: history([run(9, 'failed')]), posted: new Set<string>() };
    const [comment] = decideComments(input);
    expect(comment?.issue).toBe(1477);
    expect(comment?.body).toContain('failed on main while quarantined');
    expect(decideComments({ ...input, posted: new Set([comment?.marker ?? '']) })).toEqual([]);
  });

  test(`release is proposed after ${RELEASE_STREAK} passing main runs in a row, not before`, () => {
    const passing = Array.from({ length: RELEASE_STREAK }, (_, index) => run(100 - index, 'passed'));
    const proposal = decideComments({ entries: [quarantinedEntry], today: TODAY, history: history(passing), posted: new Set() });
    expect(proposal[0]?.body).toContain(`Proposed: release it by deleting \`.github/quarantine/${quarantinedEntry.file}\``);
    const short = passing.slice(0, RELEASE_STREAK - 1);
    expect(decideComments({ entries: [quarantinedEntry], today: TODAY, history: history(short), posted: new Set() })).toEqual([]);
  });

  test('a run that did not report the entry ends the streak', () => {
    const runs = [run(3, 'passed'), { runId: 2, url: 'u', reports: [] }, run(1, 'passed')];
    expect(streak(history(runs), quarantinedEntry.file)).toBe(1);
  });

  test('an expired entry gets one comment saying it blocks again and how to renew', () => {
    const expired = entry(NAMED, { added: '2026-10-01', expires: '2026-10-15' });
    const [comment] = decideComments({ entries: [expired], today: TODAY, history: history([run(9, 'passed')]), posted: new Set() });
    expect(comment?.body).toContain('expired on 2026-10-15, so its failures block again');
    expect(comment?.body).toContain('quarantine.ts renew');
  });

  test('the report names each entry with its result', () => {
    const verdict = decide(evidence([result(NAMED)]), [quarantinedEntry], TODAY);
    expect(toReport('cli-1', verdict).entries).toEqual([{ file: quarantinedEntry.file, test: NAMED, issue: 1477, expires: '2026-11-12', outcome: 'failed' }]);
  });
});

describe('adding and renewing from the command line', () => {
  test('add starts a 14-day quarantine that passes the check', async () => {
    const { newEntry } = await import('../../ci/quarantine.ts');
    const added = newEntry(['--test', NAMED, '--issue', '1477', '--owner', 'agent', '--reason', 'flaky'], TODAY);
    expect(added).toMatchObject({ added: TODAY, expires: '2026-11-12', renewals: [] });
    expect(validateEntry(added, entryFileName(NAMED), () => true)).toEqual([]);
  });

  test('renew appends a renewal with its reason and moves expires 14 days from today', async () => {
    const { renewed } = await import('../../ci/quarantine.ts');
    const next = renewed(entry(NAMED), 'fix in review', '2026-11-10');
    expect(next.renewals).toEqual([{ date: '2026-11-10', expires: '2026-11-24', reason: 'fix in review' }]);
    expect(validateEntry(next, entryFileName(NAMED), () => true)).toEqual([]);
  });
});

describe('reading a run\'s quarantine artifacts', () => {
  test('keeps each suite\'s report from its latest attempt', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { latestReports } = await import('../../ci/quarantine-release.ts');
    const dir = mkdtempSync(join(tmpdir(), 'quarantine-artifacts-'));
    const write = (artifact: string, reason: string) => {
      mkdirSync(join(dir, artifact));
      writeFileSync(join(dir, artifact, 'cli-1.json'), JSON.stringify({ suite: 'cli-1', forgiven: false, reason, entries: [], expired: [] }));
    };
    write('quarantine-report-cli-1-a1', 'attempt 1');
    write('quarantine-report-cli-1-a2', 'attempt 2');
    expect(latestReports(dir).map((report) => report.reason)).toEqual(['attempt 2']);
    expect(latestReports(join(dir, 'missing'))).toEqual([]);
  });
});
