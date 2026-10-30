import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appVerdict, finishAppRun } from './apps.ts';
import { addDays, entryFileName, isActive, matches, todayUtc, type LoadedEntry, type TestResult } from './entries.ts';
import { consoleTotals, parseJunit } from './junit.ts';
import { FAILURE_LOOKBACK, RELEASE_STREAK, decideComments, streak, type RunReports } from './release.ts';
import { annotations, consoleLines, notRunNote, toReport, type QuarantineReport } from './report.ts';
import { parseBaseEntries, runEntries, takeQuarantineFlag } from './source.ts';
import { honouredEntries, validateEntry } from './validate.ts';
import { decide, finalResults, type RunEvidence } from './verdict.ts';
import { newEntry, renewed } from '../../ci/quarantine.ts';
import { assertMainPushRun, latestReports } from '../../ci/quarantine-release.ts';

const TODAY = '2026-10-29';
const FILE = 'packages/cli/test/serve/hosted-sqlite.test.ts';
const NAMED = `${FILE} > peer liveness > closes a silent socket`;
const exists = () => true;

function entry(test: string, overrides: Partial<LoadedEntry> = {}): LoadedEntry {
  return {
    test, issue: 1477, owner: 'agent on #1477', reason: 'hits its 30 s limit under load',
    added: TODAY, expires: addDays(TODAY, 14), renewals: [], file: entryFileName(test), ...overrides,
  };
}

function result(id: string, outcome: TestResult['outcome'] = 'failed', line?: number): TestResult {
  const made: TestResult = { id, file: id.split(' > ')[0] ?? id, outcome };
  if (line !== undefined) made.line = line;
  return made;
}

function evidence(results: TestResult[] | undefined, overrides: Partial<RunEvidence> = {}): RunEvidence {
  const fail = finalResults(results ?? []).filter((item) => item.outcome === 'failed').length;
  return { exitCode: 1, results, totals: { fail, errors: 0 }, ...overrides };
}

// From bun 1.3.11: `bun test --reporter=junit` on a nested describe, a broken
// beforeAll and a skip.
const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" assertions="1" failures="3" skipped="1" time="0.04">
  <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="4" failures="2" skipped="1">
    <testsuite name="outer" file="test/a.test.ts" line="2">
      <testsuite name="inner &amp; more" file="test/a.test.ts" line="2">
        <testcase name="fails" classname="inner &amp;gt; outer" file="test/a.test.ts" line="2">
          <failure type="AssertionError" />
        </testcase>
      </testsuite>
      <testcase name="passes" classname="outer" file="test/a.test.ts" line="3" />
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
      { id: 'packages/cli/test/a.test.ts > outer > inner & more > fails', file: 'packages/cli/test/a.test.ts', outcome: 'failed', line: 2 },
      { id: 'packages/cli/test/a.test.ts > outer > passes', file: 'packages/cli/test/a.test.ts', outcome: 'passed', line: 3 },
      { id: 'packages/cli/test/a.test.ts > skipped', file: 'packages/cli/test/a.test.ts', outcome: 'skipped', line: 4 },
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

  test('a retried test is one test with its last attempt\'s outcome; a same-named test on another line is another', () => {
    const raw = [result(NAMED, 'failed', 3), result(NAMED, 'passed', 3), result(`${FILE} > d > works`, 'failed', 7), result(`${FILE} > d > works`, 'failed', 8)];
    expect(finalResults(raw).map((item) => [item.id, item.outcome, item.line])).toEqual([
      [NAMED, 'passed', 3], [`${FILE} > d > works`, 'failed', 7], [`${FILE} > d > works`, 'failed', 8],
    ]);
  });
});

describe('matching an entry', () => {
  test('a named entry matches only its own test', () => {
    expect(matches(entry(NAMED), result(NAMED))).toBe(true);
    expect(matches(entry(NAMED), result(`${FILE} > peer liveness > another`))).toBe(false);
  });

  test('an unnamed entry matches only the hook failure at its own describe path', () => {
    const scoped = entry(`${FILE} > flaky setup > (unnamed)`);
    expect(matches(scoped, result(`${FILE} > flaky setup > (unnamed)`))).toBe(true);
    expect(matches(scoped, result(`${FILE} > real regression > (unnamed)`))).toBe(false);
    expect(matches(scoped, result(`${FILE} > (unnamed)`))).toBe(false);
    expect(matches(entry(`${FILE} > (unnamed)`), result(`${FILE} > flaky setup > (unnamed)`))).toBe(false);
  });

  test('an entry is active for exactly 14 days: from added up to, not including, expires', () => {
    expect(isActive(entry(NAMED), TODAY)).toBe(true);
    expect(isActive(entry(NAMED), addDays(TODAY, 13))).toBe(true);
    expect(isActive(entry(NAMED), addDays(TODAY, 14))).toBe(false);
  });

  test('expiry is a UTC day, whatever the runner\'s zone', () => {
    expect(todayUtc(new Date('2026-11-12T23:30:00-08:00'))).toBe('2026-11-13');
    expect(isActive({ expires: '2026-11-12' }, todayUtc(new Date('2026-11-11T23:59:59Z')))).toBe(true);
    expect(isActive({ expires: '2026-11-12' }, todayUtc(new Date('2026-11-12T00:00:00Z')))).toBe(false);
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
    for (const exit of [null, 2, 134, 139]) {
      const verdict = decide(evidence([result(NAMED)], { exitCode: exit }), quarantined, TODAY);
      expect(verdict.forgiven).toBe(false);
      expect(verdict.exitCode).not.toBe(0);
    }
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

  test('an entry whose id names two testcases in the run forgives neither', () => {
    // Two tests with one name, a test.each case, or a `>` in a describe name.
    const verdict = decide(evidence([result(NAMED, 'failed', 7), result(NAMED, 'failed', 8)]), quarantined, TODAY);
    expect(verdict).toMatchObject({ exitCode: 1, forgiven: false });
    expect(verdict.ambiguous).toHaveLength(2);
    expect(verdict.reason).toContain('name more than one testcase');
  });

  test('a quarantined test that passes on retry counts as passed', () => {
    const verdict = decide(evidence([result(NAMED, 'failed', 3), result(NAMED, 'passed', 3)], { exitCode: 0 }), quarantined, TODAY);
    expect(verdict.outcomes.map((outcome) => outcome.outcome)).toEqual(['passed']);
  });

  test('an expired entry forgives nothing and is reported as blocking', () => {
    const expired = [entry(NAMED, { added: '2026-10-01', expires: '2026-10-15' })];
    const verdict = decide(evidence([result(NAMED)]), expired, TODAY);
    expect(verdict).toMatchObject({ exitCode: 1, forgiven: false });
    expect(verdict.expired.map((match) => match.entry.test)).toEqual([NAMED]);
    expect(consoleLines(verdict)[0]).toContain('expired 2026-10-15');
  });

  test('a passing run reports each entry\'s result and keeps exit code 0', () => {
    const hook = entry(`${FILE} > peer liveness > (unnamed)`);
    const verdict = decide(evidence([result(NAMED, 'passed')], { exitCode: 0 }), [...quarantined, hook], TODAY);
    expect(verdict).toMatchObject({ exitCode: 0, forgiven: false });
    expect(verdict.outcomes.map((outcome) => outcome.outcome)).toEqual(['passed', 'passed']);
  });

  test('an entry for a test the run did not include is not-run', () => {
    const verdict = decide(evidence([result('packages/pyric/x.test.ts > y', 'passed')], { exitCode: 0 }), quarantined, TODAY);
    expect(verdict.outcomes[0]?.outcome).toBe('not-run');
  });

  test('a quarantined failure is announced as a warning annotation', () => {
    const verdict = decide(evidence([result(NAMED)]), quarantined, TODAY);
    expect(annotations(verdict)).toEqual([`::warning title=Quarantined test failed::${NAMED} (#1477, quarantine expires 2026-11-12)`]);
  });

  test('a quarantined hook failure says some or all of the tests it guards may not have run', () => {
    expect(notRunNote(entry(`${FILE} > peer liveness > (unnamed)`))).toBe(`a hook in \`${FILE} > peer liveness\` failed; some or all of its tests may not have run`);
    expect(notRunNote(entry(`${FILE} > (unnamed)`))).toBe(`a file-level hook failed; some or all tests in ${FILE} may not have run`);
    expect(notRunNote(entry(NAMED))).toBe('');
    const verdict = decide(evidence([result(`${FILE} > (unnamed)`)]), [entry(`${FILE} > (unnamed)`)], TODAY);
    expect(annotations(verdict)[0]).toContain(`a file-level hook failed; some or all tests in ${FILE} may not have run`);
    expect(toReport('cli-1', verdict).entries[0]?.note).toContain('may not have run');
  });
});

describe('app scenarios', () => {
  const app = entry('test/apps/ai-sandbox-contents-roles', { issue: 1616 });

  test('a run whose only failed app failed in its scenario, and is quarantined, ends with exit code 0', () => {
    const apps = [{ name: 'ai-sandbox-contents-roles', ok: false, inScenario: true, step: 'the page answers' }, { name: 'node-client', ok: true }];
    expect(appVerdict({ apps, exitCode: 1 }, [app], TODAY)).toMatchObject({ exitCode: 0, forgiven: true });
  });

  test('a quarantined app that fails while it installs or loads keeps exit code 1', () => {
    for (const step of ['npm install', 'load scenario']) {
      const apps = [{ name: 'ai-sandbox-contents-roles', ok: false, inScenario: false, step }];
      expect(appVerdict({ apps, exitCode: 1 }, [app], TODAY)).toMatchObject({ exitCode: 1, forgiven: false });
    }
  });

  test('another failed app keeps exit code 1', () => {
    const apps = [{ name: 'ai-sandbox-contents-roles', ok: false, inScenario: true }, { name: 'node-client', ok: false, inScenario: true }];
    expect(appVerdict({ apps, exitCode: 1 }, [app], TODAY)).toMatchObject({ exitCode: 1, forgiven: false });
  });
});

describe('quarantine is off unless the runner is given --quarantine', () => {
  const tree = () => [entry(NAMED)];

  test('the flag is the runner\'s own argument, removed before the rest are read', () => {
    expect(takeQuarantineFlag(['--shard=1/2', '--quarantine'])).toEqual({ quarantine: true, rest: ['--shard=1/2'] });
    expect(takeQuarantineFlag(['--shard=1/2'])).toEqual({ quarantine: false, rest: ['--shard=1/2'] });
  });

  test('a push to main honours main\'s tree', () => {
    expect(runEntries({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }, tree)).toHaveLength(1);
  });

  test('a pull request honours only its base branch\'s entries, never its own tree', () => {
    const base = JSON.stringify([entry('packages/cli/test/other.test.ts > t')]);
    const pr = { GITHUB_EVENT_NAME: 'pull_request', PYRIC_QUARANTINE_BASE_ENTRIES: base };
    expect(runEntries(pr, tree).map((item) => item.test)).toEqual(['packages/cli/test/other.test.ts > t']);
    expect(runEntries({ ...pr, PYRIC_QUARANTINE_BASE_ENTRIES: '' }, tree)).toEqual([]);
    expect(runEntries({ ...pr, PYRIC_QUARANTINE_BASE_ENTRIES: 'not json' }, tree)).toEqual([]);
    expect(parseBaseEntries('{"file":"x"}')).toEqual([]);
  });

  test('a schedule, a dispatch, a merge group or a push to another branch honours none', () => {
    for (const event of ['schedule', 'workflow_dispatch', 'merge_group']) {
      expect(runEntries({ GITHUB_EVENT_NAME: event, GITHUB_REF: 'refs/heads/main' }, tree)).toEqual([]);
    }
    expect(runEntries({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/feature' }, tree)).toEqual([]);
  });

  test('the publish gate\'s app run never forgives a quarantined app', () => {
    const publishScript = readFileSync(resolve(import.meta.dir, '../../publish-alpha.sh'), 'utf8');
    expect(publishScript).toContain('bun test/apps/run.ts --packages dist/packages');
    expect(publishScript).not.toContain('--quarantine');
    const apps = [{ name: 'ai-sandbox-contents-roles', ok: false, inScenario: true }];
    // Every variable the earlier environment switch read, as a .env could set them.
    const env = { PYRIC_QUARANTINE: '1', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' };
    expect(finishAppRun('apps', { apps, exitCode: 1 }, false, env)).toBe(1);
  });

  test('only the four CI test steps pass --quarantine', () => {
    const build = readFileSync(resolve(import.meta.dir, '../../../.github/workflows/build.yml'), 'utf8');
    const commands = build.split('\n').map((line) => line.trim()).filter((line) => line.includes('bun ') && line.includes('--quarantine'));
    expect(commands).toEqual([
      'run: bun scripts/ci/test-shard.ts --shard=${{ matrix.shard }}/2 --quarantine',
      'bun scripts/ci/test-shard.ts --package=pyric --shard=${{ matrix.shard }}/2 --quarantine',
      'run: bun test/apps/run.ts --packages dist/packages --skip-slow --shard-plan test-results/app-plan.json --shard ${{ matrix.shard.index }} --quarantine',
      'run: bun scripts/ci/quarantine-test.ts --cwd packages/conformance --suite conformance --quarantine',
    ]);
  });
});

describe('checking an entry', () => {
  function problems(test: string, overrides: Partial<LoadedEntry> = {}, has: () => boolean = exists): string {
    return validateEntry(entry(test, overrides), entryFileName(test), has, TODAY).join('; ');
  }

  test('a named test in a covered suite passes', () => {
    expect(problems(NAMED)).toBe('');
  });

  test('a test outside the covered suites is refused, since no runner would honour it', () => {
    expect(problems('packages/pyric-admin/test/a.test.ts > b')).toContain('not in a suite the quarantine covers');
    expect(problems('packages/cli/test/e2e/a.pw.ts > b')).toContain('is not a *.test.ts or *.spec.ts file');
    expect(problems('packages/cli/test/a.test.tsx > b')).toContain('is not a *.test.ts or *.spec.ts file');
  });

  test('a bare file is refused; a hook failure is named by its describe path and (unnamed)', () => {
    expect(problems(FILE)).toContain('name one test');
    expect(problems(`${FILE} > (unnamed)`)).toBe('');
    expect(problems(`${FILE} > peer liveness > (unnamed)`)).toBe('');
  });

  test('a file that does not exist, a non-test file, and a wrong file name are refused', () => {
    expect(problems(NAMED, {}, () => false)).toContain('does not exist');
    expect(problems('packages/cli/src/a.ts > b')).toContain('is not a *.test.ts or *.spec.ts file');
    expect(validateEntry(entry(NAMED), 'other.json', exists, TODAY).join()).toContain(`must be named ${entryFileName(NAMED)}`);
  });

  test('an app entry needs the app\'s scenario.ts', () => {
    expect(problems('test/apps/node-client')).toBe('');
    expect(problems('test/apps/node-client', {}, () => false)).toContain('scenario.ts does not exist');
  });

  test('a quarantine longer than 14 days is refused, added or renewed', () => {
    expect(problems(NAMED, { expires: addDays(TODAY, 15) })).toContain('more than 14 days');
    const renewal = { date: TODAY, expires: addDays(TODAY, 15), reason: 'fix in review' };
    expect(problems(NAMED, { added: '2026-10-20', renewals: [renewal], expires: renewal.expires })).toContain('lasts more than 14 days');
  });

  test('an entry or a renewal dated after today is refused, by the check and by the runners', () => {
    expect(problems(NAMED, { added: '2027-03-01', expires: '2027-03-15' })).toContain('added is 2027-03-01, after today');
    const renewal = { date: '2027-06-01', expires: '2027-06-15', reason: 'later' };
    expect(problems(NAMED, { renewals: [renewal], expires: renewal.expires })).toContain('renewals[0] is dated 2027-06-01, after today');
    expect(honouredEntries([entry(NAMED, { added: '2027-03-01', expires: '2027-03-15' })], exists, TODAY)).toEqual([]);
  });

  test('a renewal needs a reason and moves expires', () => {
    const renewal = { date: TODAY, expires: addDays(TODAY, 14), reason: ' ' };
    expect(problems(NAMED, { added: '2026-10-20', renewals: [renewal], expires: renewal.expires })).toContain('needs a reason');
    const kept = { ...renewal, reason: 'fix in review' };
    expect(problems(NAMED, { added: '2026-10-20', renewals: [kept], expires: '2026-11-03' })).toContain('must equal the last renewal');
    expect(problems(NAMED, { added: '2026-10-20', renewals: [kept], expires: kept.expires })).toBe('');
  });

  test('a missing field is refused', () => {
    expect(validateEntry({ test: NAMED }, entryFileName(NAMED), exists, TODAY)).toContain('issue must be a positive integer');
  });

  test('the runners ignore an entry whose file name does not match its test, or whose test file is gone', () => {
    const wrong = { ...entry(NAMED), file: entryFileName(`${FILE} > other`) };
    expect(honouredEntries([wrong], exists, TODAY)).toEqual([]);
    expect(honouredEntries([entry(NAMED)], () => false, TODAY)).toEqual([]);
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

  test('a failure comment says whether the quarantine kept the suite green', () => {
    const forgiven = run(9, 'failed');
    const [kept] = decideComments({ entries: [quarantinedEntry], today: TODAY, history: history([{ ...forgiven, reports: forgiven.reports.map((report) => ({ ...report, forgiven: true })) }]), posted: new Set() });
    expect(kept?.body).toContain('It did not fail cli-1: every failure there was quarantined.');
    const [blocked] = decideComments({ entries: [quarantinedEntry], today: TODAY, history: history([run(9, 'failed')]), posted: new Set() });
    expect(blocked?.body).toContain('cli-1 failed anyway');
    expect(blocked?.body).not.toContain('did not fail');
  });

  test('a failure in the run just completed is commented on the tracking issue once', () => {
    const input = { entries: [quarantinedEntry], today: TODAY, history: history([run(9, 'failed')]), posted: new Set<string>() };
    const [comment] = decideComments(input);
    expect(comment?.issue).toBe(1477);
    expect(comment?.body).toContain('failed on main while quarantined');
    expect(decideComments({ ...input, posted: new Set([comment?.marker ?? '']) })).toEqual([]);
  });

  test(`a failure in a run whose own job was replaced is still commented, within the last ${FAILURE_LOOKBACK} runs`, () => {
    const runs = [run(10, 'passed'), run(9, 'failed'), run(8, 'passed')];
    const comments = decideComments({ entries: [quarantinedEntry], today: TODAY, history: history(runs), posted: new Set() });
    expect(comments.map((comment) => comment.marker)).toEqual([`<!-- quarantine:failed:${quarantinedEntry.file}:9 -->`]);
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

  test('a manual dispatch refuses any run but a push run of Build & Test on main', () => {
    const base = { id: 1, conclusion: 'success', created_at: '', html_url: '' };
    expect(() => assertMainPushRun({ ...base, event: 'pull_request', head_branch: 'main', path: '.github/workflows/build.yml' })).toThrow('only push runs');
    expect(() => assertMainPushRun({ ...base, event: 'push', head_branch: 'feature', path: '.github/workflows/build.yml' })).toThrow('only push runs');
    expect(() => assertMainPushRun({ ...base, event: 'push', head_branch: 'main', path: '.github/workflows/other.yml' })).toThrow('only push runs');
    expect(() => assertMainPushRun({ ...base, event: 'push', head_branch: 'main', path: '.github/workflows/build.yml' })).not.toThrow();
  });

  test('keeps each suite\'s report from its latest attempt', () => {
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

describe('adding and renewing from the command line', () => {
  test('add starts a 14-day quarantine that passes the check', () => {
    const added = newEntry(['--test', NAMED, '--issue', '1477', '--owner', 'agent', '--reason', 'flaky'], TODAY);
    expect(added).toMatchObject({ added: TODAY, expires: '2026-11-12', renewals: [] });
    expect(validateEntry(added, entryFileName(NAMED), exists, TODAY)).toEqual([]);
  });

  test('renew appends a renewal with its reason and moves expires 14 days from today', () => {
    const next = renewed(entry(NAMED), 'fix in review', '2026-11-10');
    expect(next.renewals).toEqual([{ date: '2026-11-10', expires: '2026-11-24', reason: 'fix in review' }]);
    expect(validateEntry(next, entryFileName(NAMED), exists, '2026-11-10')).toEqual([]);
  });
});
