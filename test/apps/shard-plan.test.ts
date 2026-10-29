import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  appSetKey,
  checkCompleteness,
  checkPlanCoversSelection,
  discoverPlannedApps,
  mergeDurations,
  MOST_SHARDS,
  planShards,
  publishedPackageNames,
  RUNNER_TESTS_SECONDS,
  SET_INSTALL_SECONDS,
  shardApps,
  takeShardOptions,
  type AppPlan,
  type PlannedApp,
  type ShardReport,
} from './shard-plan.ts';

const root = resolve(import.meta.dir, '../..');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-shard-plan-'));
  dirs.push(dir);
  return dir;
}

function apps(count: number, set: string, prefix = set): PlannedApp[] {
  return Array.from({ length: count }, (_, index) => ({ name: `${prefix}-${String(index).padStart(2, '0')}`, set }));
}

function durationsOf(planned: readonly PlannedApp[], seconds: number): Record<string, number> {
  return Object.fromEntries(planned.map((app) => [app.name, seconds]));
}

function plannedNames(plan: AppPlan): string[] {
  return plan.shards.flatMap((shard) => shard.apps);
}

/** Today's shape: about 60 apps, two large sets, a dozen small ones, and a few slow Next.js apps. */
function todaysApps(): { planned: PlannedApp[]; durations: Record<string, number> } {
  const planned = [
    ...apps(22, 'vite'),
    ...apps(14, 'admin'),
    ...Array.from({ length: 12 }, (_, index) => ({ name: `small-${index}`, set: `small-${index}` })),
    ...Array.from({ length: 8 }, (_, index) => ({ name: `alone-${index}`, set: `alone:alone-${index}` })),
    { name: 'nextjs-template', set: 'next' },
    { name: 'nextjs16', set: 'next16' },
    { name: 'chat-node-host', set: 'chat' },
    { name: 'chat-app-check', set: 'chat' },
  ];
  const durations: Record<string, number> = { ...durationsOf(planned, 20), 'nextjs-template': 100, nextjs16: 85, 'chat-node-host': 110, 'chat-app-check': 105 };
  return { planned, durations };
}

describe('the shard plan', () => {
  test('puts every planned app in exactly one shard', () => {
    const { planned, durations } = todaysApps();
    const plan = planShards(planned, durations);
    const names = plannedNames(plan);
    expect(names.toSorted()).toEqual(planned.map((app) => app.name).toSorted());
    expect(new Set(names).size).toBe(names.length);
    expect(plan.apps).toEqual(planned.map((app) => app.name).toSorted());
  });

  test('today\'s apps fill 6 to 8 shards, and the slowest shard is the one the slowest app sets', () => {
    const { planned, durations } = todaysApps();
    const plan = planShards(planned, durations);
    expect(plan.shards.length).toBeGreaterThanOrEqual(6);
    expect(plan.shards.length).toBeLessThanOrEqual(MOST_SHARDS);
    const predicted = plan.shards.map((shard) => shard.predictedSeconds);
    // chat-node-host takes 110 s after its set's install; no shard should wait longer than that one app.
    expect(Math.max(...predicted)).toBeLessThanOrEqual(110 + SET_INSTALL_SECONDS + RUNNER_TESTS_SECONDS);
  });

  test('more work makes more shards, never more than the job budget allows or than there are apps', () => {
    const few = planShards(apps(4, 'vite'), durationsOf(apps(4, 'vite'), 10));
    expect(few.shards.length).toBe(1);
    const many = apps(400, 'vite');
    expect(planShards(many, durationsOf(many, 60)).shards.length).toBe(MOST_SHARDS);
    const twoLong = apps(2, 'vite');
    expect(planShards(twoLong, durationsOf(twoLong, 900)).shards.length).toBeLessThanOrEqual(2);
  });

  test('an app with no recorded time is planned at the longest recorded time, never dropped', () => {
    const planned = [...apps(3, 'vite'), { name: 'brand-new', set: 'vite' }];
    const plan = planShards(planned, { 'vite-00': 30, 'vite-01': 140, 'vite-02': 10 });
    expect(plannedNames(plan)).toContain('brand-new');
    expect(plan.secondsByApp['brand-new']).toBe(140);
    expect(plan.unrecorded).toEqual(['brand-new']);
  });

  test('with no recorded times at all, every app gets the default and the plan still balances', () => {
    const planned = apps(40, 'vite');
    const plan = planShards(planned, {});
    expect(plan.unrecorded).toHaveLength(40);
    expect(new Set(Object.values(plan.secondsByApp))).toEqual(new Set([120]));
    const sizes = plan.shards.map((shard) => shard.apps.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  test('a shard lists its apps longest first, the order the runner starts them in', () => {
    const planned = apps(6, 'vite');
    const plan = planShards(planned, { 'vite-00': 5, 'vite-01': 50, 'vite-02': 20, 'vite-03': 40, 'vite-04': 10, 'vite-05': 30 });
    for (const shard of plan.shards) {
      const seconds = shard.apps.map((name) => plan.secondsByApp[name]!);
      expect(seconds).toEqual(seconds.toSorted((a, b) => b - a));
    }
  });

  test('a short app that starts its set\'s install starts before longer apps whose set is already installing', () => {
    const planned = [...apps(3, 'vite'), { name: 'lone', set: 'lone' }];
    const plan = planShards(planned, { 'vite-00': 40, 'vite-01': 30, 'vite-02': 20, lone: 15 });
    expect(plan.shards).toHaveLength(1);
    // lone counts 15 + 30 for its install, which puts it after vite-00 (40 + 30) and before vite-01 (30).
    expect(plan.shards[0]!.apps).toEqual(['vite-00', 'lone', 'vite-01', 'vite-02']);
  });

  test('keeps a dependency set in one shard when the balance allows, so each set installs once', () => {
    const planned = [...apps(8, 'vite'), ...apps(8, 'admin')];
    const plan = planShards(planned, durationsOf(planned, 22));
    expect(plan.shards).toHaveLength(2);
    for (const shard of plan.shards) expect(shard.sets).toHaveLength(1);
  });

  test('charges one install per set in a shard, and the runner unit tests to one shard only', () => {
    const planned = [...apps(4, 'vite'), ...apps(4, 'admin')];
    const plan = planShards(planned, durationsOf(planned, 40));
    const withTests = plan.shards.filter((shard) => shard.runnerTests);
    expect(withTests).toHaveLength(1);
    for (const shard of plan.shards) {
      // Four apps run at once. The first apps wait on their installs together, and each further set holds one slot.
      const work = SET_INSTALL_SECONDS + (shard.apps.reduce((sum, name) => sum + plan.secondsByApp[name]!, 0) + (shard.sets.length - 1) * SET_INSTALL_SECONDS) / 4;
      const longest = 40 + SET_INSTALL_SECONDS;
      const runnerTests = shard.runnerTests ? RUNNER_TESTS_SECONDS : 0;
      expect(shard.predictedSeconds).toBeCloseTo(Math.max(work, longest) + runnerTests, 5);
    }
  });

  test('is the same plan for the same inputs', () => {
    const { planned, durations } = todaysApps();
    expect(planShards(planned, durations)).toEqual(planShards([...planned].reverse(), durations));
  });

  test('a plan of no apps is an error, so a broken discovery cannot pass as an empty run', () => {
    expect(() => planShards([], {})).toThrow('no app scenario to plan');
  });

  test('records only the times it read, not the defaults it filled in', () => {
    const plan = planShards([{ name: 'a', set: 's' }, { name: 'b', set: 's' }], { a: 12, gone: 4 });
    expect(plan.durations).toEqual({ a: 12 });
  });
});

describe('dependency sets, as the planner sees them before the run', () => {
  const published = ['pyric', 'pyric-admin', '@pyric/cli', '@pyric/ui', '@pyric/studio', 'create-pyric'];
  function app(files: Record<string, string>): string {
    const dir = tempDir();
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    return dir;
  }
  const manifest = (dependencies: Record<string, string>) => JSON.stringify({ name: 'app', private: true, dependencies });

  test('apps that name the same third-party packages share a set, whatever spec they give Pyric', () => {
    const a = app({ 'package.json': manifest({ '@pyric/cli': 'workspace:*', vite: '^6.0.0' }) });
    const b = app({ 'package.json': manifest({ '@pyric/cli': '0.0.1', vite: '^6.0.0' }) });
    expect(appSetKey(a, 'a', published)).toBe(appSetKey(b, 'b', published));
  });

  test('a different third-party range is a different set', () => {
    const a = app({ 'package.json': manifest({ '@pyric/cli': '*', vite: '^6.0.0' }) });
    const b = app({ 'package.json': manifest({ '@pyric/cli': '*', vite: '^7.0.0' }) });
    expect(appSetKey(a, 'a', published)).not.toBe(appSetKey(b, 'b', published));
  });

  test('an app that installs alone is a set of its own', () => {
    const a = app({ 'package.json': manifest({ vite: '^6.0.0' }), 'package-lock.json': '{}' });
    expect(appSetKey(a, 'lonely', published)).toBe('alone:lonely');
  });

  test('the published packages are the workspace packages that are not private', () => {
    expect(publishedPackageNames(root).toSorted()).toEqual(published.toSorted());
  });
});

describe('the apps the plan covers', () => {
  test('every app with a scenario.ts, less the ones that mark themselves slow', () => {
    const planned = discoverPlannedApps(root);
    const names = planned.map((app) => app.name);
    expect(names).toContain('create-pyric-chat-app-check');
    expect(names).not.toContain('host-closes-silent-page');
    expect(names).not.toContain('host-closes-silent-consumer');
    expect(names).toEqual(names.toSorted());
  });

  test('a shard run fails unless the plan covers exactly the apps the runner would run', () => {
    const plan = planShards([{ name: 'a', set: 's' }, { name: 'b', set: 's' }], {});
    expect(checkPlanCoversSelection(plan, ['a', 'b'])).toEqual([]);
    expect(checkPlanCoversSelection(plan, ['a', 'b', 'c'])).toEqual(['the plan leaves out c, which this run selects']);
    expect(checkPlanCoversSelection(plan, ['a'])).toEqual(['the plan names b, which this run does not select']);
  });
});

describe('a runner shard on the command line', () => {
  test('takes the plan file and the shard number out of the arguments it passes on', () => {
    expect(takeShardOptions(['--packages', 'dist/packages', '--shard-plan', 'plan.json', '--shard', '3', '--skip-slow'])).toEqual({
      argv: ['--packages', 'dist/packages', '--skip-slow'],
      shard: { planFile: 'plan.json', index: 3 },
    });
    expect(takeShardOptions(['--skip-slow'])).toEqual({ argv: ['--skip-slow'] });
  });

  test('refuses one option without the other, and a shard number that is not a whole number', () => {
    expect(() => takeShardOptions(['--shard', '1'])).toThrow('--shard and --shard-plan go together');
    expect(() => takeShardOptions(['--shard-plan', 'plan.json'])).toThrow('--shard and --shard-plan go together');
    expect(() => takeShardOptions(['--shard-plan', 'plan.json', '--shard', 'x'])).toThrow('--shard takes a whole number of at least 1');
  });

  test('a shard number the plan does not have is an error', () => {
    const plan = planShards([{ name: 'a', set: 's' }], {});
    expect(shardApps(plan, 1)).toEqual(['a']);
    expect(() => shardApps(plan, 2)).toThrow('the plan has 1 shard, so there is no shard 2');
  });
});

describe('shard completeness', () => {
  const plan = planShards([...apps(6, 'vite'), ...apps(6, 'admin')], durationsOf([...apps(6, 'vite'), ...apps(6, 'admin')], 60));
  const reportOf = (index: number, names = plan.shards[index - 1]!.apps): ShardReport => ({
    index,
    apps: names.map((name) => ({ name, ok: true, scenarioSeconds: 10 })),
  });
  const allReports = () => plan.shards.map((shard) => reportOf(shard.index));

  test('passes when every shard reports exactly its planned apps', () => {
    expect(plan.shards.length).toBeGreaterThan(1);
    expect(checkCompleteness(plan, allReports())).toEqual([]);
  });

  test('a shard with no report fails', () => {
    const missing = plan.shards.at(-1)!;
    expect(checkCompleteness(plan, allReports().slice(0, -1))).toEqual([
      `shard ${missing.index} sent no report, so its planned apps did not run: ${missing.apps.join(', ')}`,
    ]);
  });

  test('a shard that ran fewer apps than planned fails, naming them', () => {
    const [first, ...rest] = allReports();
    const dropped = first!.apps.at(-1)!.name;
    expect(checkCompleteness(plan, [{ ...first!, apps: first!.apps.slice(0, -1) }, ...rest])).toEqual([`${dropped} was planned for shard 1 but no shard ran it`]);
  });

  test('an app run twice, run in the wrong shard, or never planned fails', () => {
    const reports = allReports();
    const stray = plan.shards[1]!.apps[0]!;
    reports[0]!.apps.push({ name: stray, ok: true, scenarioSeconds: 1 }, { name: 'unplanned', ok: true, scenarioSeconds: 1 });
    expect(checkCompleteness(plan, reports)).toEqual([
      `${stray} ran 2 times (shards 1, 2)`,
      `${stray} ran in shard 1, but the plan put it in shard 2`,
      'unplanned ran in shard 1, but the plan does not name it',
    ]);
  });

  test('two reports from one shard, or a report from a shard the plan does not have, fail', () => {
    expect(checkCompleteness(plan, [...allReports(), { index: 1, apps: [] }])).toContain('shard 1 sent 2 reports');
    expect(checkCompleteness(plan, [...allReports(), { index: 99, apps: [] }])).toContain('shard 99 sent a report, but the plan has no such shard');
  });
});

describe('the times main records', () => {
  test('a passing app takes its new time, a failed one keeps its old time, and an app gone from the plan is dropped', () => {
    const dir = tempDir();
    const file = join(dir, 'test-results', 'app-durations.json');
    const plan = planShards([{ name: 'a', set: 's' }, { name: 'b', set: 's' }], { a: 10, b: 20, removed: 5 });
    mergeDurations(file, plan, [{ index: 1, apps: [{ name: 'a', ok: true, scenarioSeconds: 33.33 }, { name: 'b', ok: false, scenarioSeconds: 1 }] }]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 33.3, b: 20 });
  });
});

describe('the workflow runs the shards the plan makes', () => {
  type Step = { name?: string; run?: string; uses?: string; if?: string; with?: Record<string, string>; env?: Record<string, string> };
  type Job = { name?: string; if?: string; needs?: string | string[]; outputs?: Record<string, string>; strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, string> }; steps?: Step[] };
  const workflow = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/build.yml'), 'utf8')) as { jobs: Record<string, Job> };
  const steps = (job: string) => workflow.jobs[job]?.steps ?? [];

  test('the plan job tests the planner, then plans, and exposes the plan', () => {
    const plan = steps('plan');
    const tests = plan.findIndex((step) => step.run?.includes('test/apps/shard-plan.test.ts'));
    const planner = plan.findIndex((step) => step.run?.startsWith('bun test/apps/shard-plan.ts plan'));
    expect(tests).toBeGreaterThanOrEqual(0);
    expect(planner).toBeGreaterThan(tests);
    expect(workflow.jobs.plan?.outputs?.['app-plan']).toBe('${{ steps.app-plan.outputs.app-plan }}');
    expect(workflow.jobs.plan?.outputs?.['app-shards']).toBe('${{ steps.app-plan.outputs.app-shards }}');
  });

  test('the app scenarios matrix comes from the plan, and one failing shard does not cancel the rest', () => {
    const job = workflow.jobs['app-scenarios'];
    expect(job?.strategy?.matrix?.shard).toBe('${{ fromJSON(needs.plan.outputs.app-shards) }}');
    expect(job?.strategy?.['fail-fast']).toBe(false);
    const run = steps('app-scenarios').find((step) => step.run?.includes('test/apps/run.ts'));
    expect(run?.run).toContain('--shard-plan');
    expect(run?.run).toContain('--shard ${{ matrix.shard.index }}');
    expect(run?.run).toContain('--skip-slow');
  });

  test('every shard uploads its report, whatever its result', () => {
    const upload = steps('app-scenarios').find((step) => step.with?.name === 'app-shard-report-${{ matrix.shard.index }}');
    expect(upload?.if).toBe('always()');
  });

  test('CI / required checks the shards ran every planned app once, and only main records the times', () => {
    const required = steps('required');
    const check = required.find((step) => step.run?.startsWith('bun test/apps/shard-plan.ts check'));
    expect(check?.if).toBe("always() && needs.plan.outputs.app-scenarios == 'true'");
    expect(check?.env?.APP_PLAN).toBe('${{ needs.plan.outputs.app-plan }}');
    const save = required.find((step) => step.uses?.startsWith('actions/cache/save'));
    expect(save?.if).toContain("github.event_name == 'push' || github.event_name == 'schedule'");
    const anySave = Object.entries(workflow.jobs).flatMap(([name, job]) => (job.steps ?? [])
      .filter((step) => step.with?.path === 'test-results/app-durations.json' && !step.uses?.startsWith('actions/cache/restore'))
      .map(() => name));
    expect(anySave).toEqual(['required']);
  });
});

describe('the planner on the command line', () => {
  test('writes the plan and the matrix to the step outputs', () => {
    const dir = tempDir();
    const output = join(dir, 'output');
    const durations = join(dir, 'durations.json');
    writeFileSync(durations, '{}');
    const run = Bun.spawnSync(['bun', join(import.meta.dir, 'shard-plan.ts'), 'plan', '--durations', durations], { env: { ...process.env, GITHUB_OUTPUT: output } });
    expect(run.exitCode).toBe(0);
    const lines = readFileSync(output, 'utf8').trim().split('\n');
    const plan = JSON.parse(lines.find((line) => line.startsWith('app-plan='))!.slice('app-plan='.length)) as AppPlan;
    const shards = JSON.parse(lines.find((line) => line.startsWith('app-shards='))!.slice('app-shards='.length)) as Array<{ index: number; total: number; runnerTests: boolean }>;
    expect(shards.map((shard) => shard.index)).toEqual(plan.shards.map((shard) => shard.index));
    expect(shards.every((shard) => shard.total === plan.shards.length)).toBe(true);
    expect(plan.apps).toEqual(discoverPlannedApps(root).map((app) => app.name));
  });
});
