import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The merge queue tests a group of pull requests on a synthetic
// gh-readonly-queue/main/pr-<n>-<sha> branch and merges them only when the
// ruleset's required checks pass on that run. These tests pin what the queue
// relies on: Build & Test runs on the group, `CI / required` reports under the
// same name, the group selects at least the proof any pull request in it could
// have selected, and no non-gating workflow lands on the merge path.

const workflowDir = resolve(import.meta.dir, '../../.github/workflows');

interface Job {
  name?: string;
  if?: string;
  steps?: { name?: string; env?: Record<string, string> }[];
}

interface Workflow {
  on: Record<string, { types?: string[] } | null>;
  concurrency?: { group: string; 'cancel-in-progress': boolean | string };
  jobs: Record<string, Job>;
}

function workflow(file: string): Workflow {
  return Bun.YAML.parse(readFileSync(resolve(workflowDir, file), 'utf8')) as Workflow;
}

const build = workflow('build.yml');

describe('merge queue workflow contract', () => {
  test('Build & Test runs when the queue requests checks for a group', () => {
    expect(build.on.merge_group).toEqual({ types: ['checks_requested'] });
  });

  test('only Build & Test gates a merge group', () => {
    const triggered = readdirSync(workflowDir)
      .filter((file) => /\.ya?ml$/.test(file))
      .filter((file) => 'merge_group' in (workflow(file).on ?? {}));
    expect(triggered).toEqual(['build.yml']);
  });

  test('CI / required always reports, under the same name on every event', () => {
    expect(build.jobs.required?.name).toBe('CI / required');
    expect(build.jobs.required?.if).toBe('always()');
  });

  test('a group run shares no concurrency group with pull request or main runs', () => {
    // github.ref is refs/pull/<n>/merge on a pull request, refs/heads/main on
    // a push, and the group's own refs/heads/gh-readonly-queue/main/pr-<n>-<sha>
    // on a merge group, so cancel-in-progress only ever cancels a run of the
    // same ref.
    expect(build.concurrency?.group).toBe('build-${{ github.workflow }}-${{ github.ref }}');
  });

  test('the plan receives the event name, so a group selects the full proof', () => {
    const select = build.jobs.plan?.steps?.find((step) => step.name === 'Select proof');
    expect(select?.env?.CI_EVENT_NAME).toBe('${{ github.event_name }}');
  });

  test('label-gated jobs read the plan, not the pull request labels a group lacks', () => {
    const labelGated = ['release-contract', 'install-matrix', 'standalone'];
    for (const job of labelGated) {
      expect(build.jobs[job]?.if).toContain("needs.plan.outputs.release-proof == 'true'");
      expect(build.jobs[job]?.if).not.toContain('github.event.pull_request.labels');
    }
    const verify = build.jobs.required?.steps?.find((step) => step.name === 'Verify every selected proof passed');
    expect(verify?.env?.CI_REQUIRE_PACKAGING).toBe('${{ needs.plan.outputs.release-proof }}');
  });

  test('the plan exposes the release proof selection', () => {
    const outputs = (build.jobs.plan as Job & { outputs?: Record<string, string> }).outputs;
    expect(outputs?.['release-proof']).toBe('${{ steps.plan.outputs.release-proof }}');
  });
});
