import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The decision, log parsing and GitHub side are tested next to their modules
// in scripts/lib/main-failure/. This file pins the workflow that runs them.

describe('the main failure workflow', () => {
  const workflowDir = resolve(import.meta.dir, '../../.github/workflows');
  const read = (file: string) => Bun.YAML.parse(readFileSync(resolve(workflowDir, file), 'utf8')) as {
    name: string;
    on: Record<string, Record<string, unknown> | null>;
    permissions: Record<string, string>;
    jobs: Record<string, {
      if?: string;
      permissions?: Record<string, string>;
      steps: { run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }[];
    }>;
  };
  const lane = read('main-failure.yml');

  test('it follows completed Build & Test runs on main, and a dispatch, never a pull request', () => {
    expect(Object.keys(lane.on).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
    expect(lane.on.workflow_run).toEqual({ workflows: [read('build.yml').name], types: ['completed'], branches: ['main'] });
  });

  test('a dispatch defaults to a dry run', () => {
    const inputs = lane.on.workflow_dispatch?.inputs as Record<string, { default?: unknown; required?: boolean }>;
    expect(inputs.dry_run?.default).toBe(true);
    expect(inputs.run_id?.required).toBe(true);
  });

  test('it holds only the permissions it needs', () => {
    expect(lane.permissions).toEqual({ contents: 'read' });
    expect(lane.jobs.classify?.permissions).toEqual({ actions: 'write', contents: 'read', issues: 'write' });
  });

  test('it runs this script', () => {
    expect(lane.jobs.classify?.steps.some((step) => step.run === 'bun scripts/ci/main-failure.ts')).toBe(true);
  });

  test('it handles only push runs, and skips an attempt this lane reran itself', () => {
    const guard = (lane.jobs.classify?.if ?? '').replace(/\s+/g, ' ').trim();
    expect(guard).toBe([
      "github.event_name == 'workflow_dispatch' ||",
      "(github.event.workflow_run.event == 'push' &&",
      '(github.event.workflow_run.run_attempt == 1 ||',
      "github.event.workflow_run.triggering_actor.login != 'github-actions[bot]'))",
    ].join(' '));
  });

  test('only a dispatch can ask for a dry run, and the checkout keeps no token', () => {
    const step = lane.jobs.classify?.steps.find((candidate) => candidate.run === 'bun scripts/ci/main-failure.ts');
    expect(step?.env?.DRY_RUN).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && 'true' || 'false' }}");
    const checkout = lane.jobs.classify?.steps.find((candidate) => candidate.uses === 'actions/checkout@v4');
    expect(checkout?.with?.['persist-credentials']).toBe(false);
  });
});
