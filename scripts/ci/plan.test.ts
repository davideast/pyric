import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverScenarios, type Scenario } from '../../test/apps/shard-plan.ts';
import {
  appSelectionFile,
  determinePackaging,
  determineReleaseProof,
  determineRtdbDifferential,
  parseNameStatus,
  scenariosNamedIn,
  selectAppScenarios,
  shadowSummary,
  SMOKE_SCENARIOS,
  type AppScenarioSelection,
} from './plan.ts';

const scenarios: Scenario[] = [
  { name: 'foo', slow: false },
  { name: 'bar', slow: false },
  { name: 'baz-2', slow: false },
  { name: 'sleepy', slow: true },
];

function pullRequest(input: { paths?: string[]; body?: string; labels?: string[]; renames?: Array<[string, string]> }): AppScenarioSelection {
  return selectAppScenarios({
    event: 'pull_request',
    labels: input.labels ?? [],
    paths: [
      ...(input.paths ?? []).map((path) => ({ path })),
      ...(input.renames ?? []).map(([previousPath, path]) => ({ path, previousPath })),
    ],
    body: input.body ?? '',
    scenarios,
  });
}

describe('app scenario selection', () => {
  test('a change to any file of a scenario selects that scenario', () => {
    for (const path of ['test/apps/foo/scenario.ts', 'test/apps/foo/package.json', 'test/apps/foo/src/deep/main.js']) {
      expect(pullRequest({ paths: [path] })).toEqual({ kind: 'some', apps: ['foo'] });
    }
  });

  test('each repository scenario is selected by a change to its own files', () => {
    const root = resolve(import.meta.dir, '../..');
    const real = discoverScenarios(root);
    expect(real.length).toBeGreaterThan(0);
    for (const { name, slow } of real) {
      const selection = selectAppScenarios({
        event: 'pull_request', labels: [], body: '', scenarios: real,
        paths: [{ path: `test/apps/${name}/scenario.ts` }],
      });
      expect(selection).toEqual(slow ? { kind: 'none' } : { kind: 'some', apps: [name] });
    }
  });

  test('a body naming test/apps/<name> selects that scenario', () => {
    expect(pullRequest({ body: 'Integration test: `test/apps/foo` drives the dev server.' })).toEqual({ kind: 'some', apps: ['foo'] });
    expect(pullRequest({ body: 'See test/apps/baz-2/scenario.ts and test/apps/bar.' })).toEqual({ kind: 'some', apps: ['bar', 'baz-2'] });
  });

  test('changed and named scenarios add up, each once', () => {
    expect(pullRequest({ paths: ['test/apps/bar/scenario.ts'], body: 'test/apps/foo and test/apps/bar' }))
      .toEqual({ kind: 'some', apps: ['bar', 'foo'] });
  });

  test('a body naming a path under test/apps that is no scenario selects nothing for it', () => {
    expect(pullRequest({ body: 'test/apps/run.ts, test/apps/README.md, test/apps/unknown, test/apps/' })).toEqual({ kind: 'none' });
  });

  test('a pull request that changes and names no scenario, and no code the scenarios run, selects none, so the jobs skip', () => {
    expect(pullRequest({ paths: ['packages/pyric/src/index.ts', 'packages/cli/src/rules/eval.ts', 'docs/x.md'] })).toEqual({ kind: 'none' });
    expect(pullRequest({ paths: [] })).toEqual({ kind: 'none' });
  });

  test('a change to the packing and install path selects every app, whatever the body says', () => {
    for (const path of [
      'scripts/pack-packages.sh',
      'scripts/lib/rewrite-workspace-deps.mjs',
      'scripts/build.sh',
      'bun.lock',
      'packages/cli/package.json',
      'packages/pyric/package.json',
      '.github/actions/restore-dist/action.yml',
      'scripts/ci/build-input-key.sh',
    ]) {
      expect(pullRequest({ paths: [path], body: 'No runtime path.' })).toEqual({ kind: 'all' });
    }
  });

  test('a change to code the scenarios run selects the smoke set, plus changed and named scenarios', () => {
    const smoke = [...SMOKE_SCENARIOS].sort();
    for (const path of [
      'packages/cli/src/serve/vite-plugin.ts',
      'packages/cli/src/register/index.ts',
      'packages/cli/src/remote/index.ts',
      'packages/cli/src/cli/serve.ts',
      'packages/cli/src/next/with-pyric.ts',
      'packages/cli/src/bundler/edge-runtime.ts',
      'packages/cli/src/functions/runtime.ts',
      'packages/live/src/vite.ts',
      'packages/pyric-admin/src/database/index.ts',
      'packages/pyric/src/ai/broker/gemini-engine.ts',
    ]) {
      expect(pullRequest({ paths: [path], body: 'No runtime path.' })).toEqual({ kind: 'some', apps: smoke });
    }
    expect(pullRequest({ paths: ['packages/live/src/vite.ts', 'test/apps/foo/scenario.ts'], body: 'test/apps/bar' }))
      .toEqual({ kind: 'some', apps: [...smoke, 'bar', 'foo'].sort() });
  });

  test('the smoke set is 3 to 5 scenarios of this repository that are not slow, including split-port Next.js', () => {
    const real = discoverScenarios(resolve(import.meta.dir, '../..'));
    expect(SMOKE_SCENARIOS.length).toBeGreaterThanOrEqual(3);
    expect(SMOKE_SCENARIOS.length).toBeLessThanOrEqual(5);
    expect(SMOKE_SCENARIOS).toContain('nextjs-template');
    expect(SMOKE_SCENARIOS).toContain('nextjs16-firebase-imports');
    for (const name of SMOKE_SCENARIOS) {
      expect(real.find((scenario) => scenario.name === name)).toEqual({ name, slow: false });
    }
  });

  test('a slow scenario is left to the Slow app scenarios workflow', () => {
    expect(pullRequest({ paths: ['test/apps/sleepy/scenario.ts'], body: 'test/apps/sleepy' })).toEqual({ kind: 'none' });
    expect(pullRequest({ paths: ['test/apps/sleepy/scenario.ts', 'test/apps/foo/x.ts'] })).toEqual({ kind: 'some', apps: ['foo'] });
  });

  test('a rename selects the scenario on either side', () => {
    expect(pullRequest({ renames: [['test/apps/foo/a.ts', 'test/other/a.ts']] })).toEqual({ kind: 'some', apps: ['foo'] });
    expect(pullRequest({ renames: [['test/other/a.ts', 'test/apps/bar/a.ts']] })).toEqual({ kind: 'some', apps: ['bar'] });
  });

  test('a change to the runner or any other shared file under test/apps selects every app', () => {
    for (const path of ['test/apps/run.ts', 'test/apps/driver.ts', 'test/apps/shard-plan.ts', 'test/apps/replay/replay.test.ts', 'test/apps/README.md']) {
      expect(pullRequest({ paths: [path] })).toEqual({ kind: 'all' });
    }
  });

  test('a scenario directory this checkout no longer has counts as shared, so every app runs', () => {
    expect(pullRequest({ paths: ['test/apps/removed-app/scenario.ts'] })).toEqual({ kind: 'all' });
  });

  test('a change to the workflow that runs the scenarios selects every app', () => {
    expect(pullRequest({ paths: ['.github/workflows/build.yml'] })).toEqual({ kind: 'all' });
  });

  test('the ci-full and ci-slow-scenarios labels select every app', () => {
    for (const label of ['ci-full', 'ci-slow-scenarios']) {
      expect(pullRequest({ labels: [label] })).toEqual({ kind: 'all' });
    }
    expect(pullRequest({ labels: ['ci-packaging'] })).toEqual({ kind: 'none' });
  });

  test('every app runs outside pull requests: main, the nightly run, a merge group, a manual run', () => {
    for (const event of ['push', 'schedule', 'merge_group', 'workflow_dispatch'] as const) {
      expect(selectAppScenarios({ event, labels: [], paths: [], body: '', scenarios })).toEqual({ kind: 'all' });
    }
  });

  test('the planner file names the selected apps, or every app otherwise', () => {
    expect(appSelectionFile({ kind: 'some', apps: ['bar', 'foo'] })).toBe('{"apps":["bar","foo"]}\n');
    expect(appSelectionFile({ kind: 'all' })).toBe('{"apps":"all"}\n');
    expect(appSelectionFile({ kind: 'none' })).toBe('{"apps":"all"}\n');
  });

  test('the plan job hands the body to plan.ts and its selection to the shard planner', () => {
    type Step = { id?: string; run?: string; env?: Record<string, string> };
    const workflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8')) as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    const steps = workflow.jobs.plan?.steps ?? [];
    const select = steps.findIndex((step) => step.id === 'plan');
    const shards = steps.findIndex((step) => step.id === 'app-plan');
    expect(steps[select]?.env?.CI_PR_BODY).toBe('${{ github.event.pull_request.body }}');
    expect(steps[select]?.run).toBe('bun scripts/ci/plan.ts');
    expect(steps[shards]?.run).toContain('--apps test-results/app-selection.json');
    expect(shards).toBeGreaterThan(select);
  });

  test('names come from every test/apps/<name> mention, punctuation left off', () => {
    expect(scenariosNamedIn('`test/apps/foo`, test/apps/bar. (test/apps/baz-2)')).toEqual(['foo', 'bar', 'baz-2']);
  });
});

describe('RTDB differential selection', () => {
  test('runs for a pull request touching the served hosts, the RTDB engine, or the rules engine', () => {
    for (const path of [
      'packages/cli/src/serve/worker/host/rtdb.ts',
      'packages/pyric/src/database/listeners.ts',
      'packages/pyric/src/rules/internal/rtdb.ts',
      'packages/rules/src/internal/rtdb.ts',
      'packages/cli/test/serve/rtdb-differential/generator.ts',
    ]) {
      expect(determineRtdbDifferential({ event: 'pull_request', paths: [{ path }] })).toBe(true);
    }
  });

  test('runs for a rename out of a selected directory', () => {
    expect(determineRtdbDifferential({
      event: 'pull_request',
      paths: [{ path: 'packages/cli/src/other.ts', previousPath: 'packages/cli/src/serve/other.ts' }],
    })).toBe(true);
  });

  test('skips a pull request that touches none of them', () => {
    expect(determineRtdbDifferential({ event: 'pull_request', paths: [{ path: 'packages/pyric/src/storage/index.ts' }] })).toBe(false);
  });

  test('always runs outside pull requests', () => {
    expect(determineRtdbDifferential({ event: 'schedule', paths: [] })).toBe(true);
    expect(determineRtdbDifferential({ event: 'push', paths: [] })).toBe(true);
    expect(determineRtdbDifferential({ event: 'merge_group', paths: [] })).toBe(true);
  });
});

describe('CI change input', () => {
  test('preserves both sides of renames and ordinary changed paths', () => {
    expect(parseNameStatus('M\0README.md\0R100\0docs/old.md\0docs/new.md\0D\0gone.txt\0')).toEqual([
      { path: 'README.md' },
      { path: 'docs/new.md', previousPath: 'docs/old.md' },
      { path: 'gone.txt' },
    ]);
  });

  test('forces packaging gate on push to main', () => {
    expect(determinePackaging({ event: 'push', labels: [], paths: [] })).toBe(true);
  });

  test('forces packaging gate when ci-packaging label is present', () => {
    expect(determinePackaging({ event: 'pull_request', labels: ['ci-packaging'], paths: [] })).toBe(true);
  });

  test('forces packaging gate when changed paths require packaging proof', () => {
    expect(determinePackaging({ event: 'pull_request', labels: [], paths: [{ path: 'packages/pyric/package.json' }] })).toBe(true);
  });

  test('skips packaging gate when no packaging proof required on PR', () => {
    expect(determinePackaging({ event: 'pull_request', labels: [], paths: [{ path: 'README.md' }] })).toBe(false);
  });

  test('forces packaging gate on a merge group, which carries no labels', () => {
    expect(determinePackaging({ event: 'merge_group', labels: [], paths: [] })).toBe(true);
  });

  test('forces packaging gate on merge-queue staging and main workflow dispatches, not arbitrary branch dispatches', () => {
    expect(determinePackaging({ event: 'workflow_dispatch', ref: 'refs/heads/merge-queue/staging', labels: [], paths: [] })).toBe(true);
    expect(determinePackaging({ event: 'workflow_dispatch', ref: 'refs/heads/main', labels: [], paths: [] })).toBe(true);
    expect(determinePackaging({ event: 'workflow_dispatch', ref: 'refs/heads/auto-revert/abc', labels: [], paths: [] })).toBe(false);
  });
});

describe('release proof selection (install matrix and standalone smoke)', () => {
  test('a pull request opts in with the ci-packaging label only', () => {
    expect(determineReleaseProof({ event: 'pull_request', labels: ['ci-packaging'] })).toBe(true);
    expect(determineReleaseProof({ event: 'pull_request', labels: [] })).toBe(false);
    expect(determineReleaseProof({ event: 'pull_request', labels: ['ci-full'] })).toBe(false);
  });

  test('a merge group always runs it, since one of its pull requests may carry the label', () => {
    expect(determineReleaseProof({ event: 'merge_group', labels: [] })).toBe(true);
  });

  test('push, schedule and default dispatch keep today\'s behavior, while dispatchReleaseProof opts a staged PR in', () => {
    for (const event of ['push', 'schedule', 'workflow_dispatch'] as const) {
      expect(determineReleaseProof({ event, labels: [] })).toBe(false);
    }
    expect(determineReleaseProof({ event: 'workflow_dispatch', labels: [], dispatchReleaseProof: true })).toBe(true);
  });
});

describe('shadow check set record', () => {
  type Job = { outputs?: Record<string, string> };
  const workflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8')) as { jobs: Record<string, Job> };

  test('the plan job exposes the shadow selection as an output', () => {
    expect(workflow.jobs.plan?.outputs?.['shadow-check-set']).toBe('${{ steps.plan.outputs.shadow-check-set }}');
  });

  test('nothing in the workflow reads the shadow selection, so it gates nothing', () => {
    const text = readFileSync(resolve(import.meta.dir, '../../.github/workflows/build.yml'), 'utf8');
    const uses = text.split('\n').filter((line) => line.includes('shadow-check-set') && !line.trimStart().startsWith('#'));
    expect(uses).toEqual(['      shadow-check-set: ${{ steps.plan.outputs.shadow-check-set }}']);
  });

  test('the job summary names the shadow selection and the set that gates', () => {
    const rulesOnly = shadowSummary({ shadowCheckSet: 'rules-only', checkSet: 'full' });
    expect(rulesOnly).toContain('`rules-only`');
    expect(rulesOnly).toContain('bun test --cwd packages/rules');
    expect(rulesOnly).toContain('`full`');
    expect(shadowSummary({ shadowCheckSet: 'none', checkSet: 'docs-only' })).not.toContain('packages/rules');
  });
});
