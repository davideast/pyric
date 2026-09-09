/**
 * The branch lifecycle behind the `dry_run_experiment` tool: which action
 * reaches which canonical operation, and what each one carries across.
 */
import { describe, expect, it } from 'bun:test';

import { BRANCH_ROUTES } from '../../../../src/bridge/surface/render/discriminator-branch-routes.js';

/** The route one call takes, the way the renderer picks it. */
function routeFor(args: Record<string, unknown>) {
  const route = BRANCH_ROUTES.find((candidate) => candidate.selects(args));
  if (route === undefined) throw new Error(`no branch route selects ${JSON.stringify(args)}`);
  return route;
}

describe('the branch routes', () => {
  it('take every action of the lifecycle to its canonical operation', () => {
    const operations = BRANCH_ROUTES.map((route) => [route.action, route.operation]);
    expect(operations).toEqual([
      ['fork', 'fork_sandbox_branch'],
      ['apply', 'apply_sandbox_events'],
      ['diff', 'diff_sandbox_branch'],
      ['promote', 'promote_sandbox_branch'],
      ['discard', 'discard_sandbox_branch'],
      ['list', 'list_sandbox_branches'],
    ]);
  });

  it('carry the branch under the name the method takes it as', () => {
    const forked = routeFor({ action: 'fork', branchId: 'draft', candidateRules: 'rules' });
    expect(forked.translate({ action: 'fork', branchId: 'draft', candidateRules: 'rules' })).toEqual(
      { branch: 'draft', candidateRules: 'rules' },
    );
  });

  it('parse the encoded mutations an apply carries', () => {
    const args = { action: 'apply', branchId: 'draft', mutationsJson: '[{"kind":"write"}]' };
    expect(routeFor(args).translate(args)).toEqual({
      branch: 'draft',
      events: [{ kind: 'write' }],
    });
  });

  it('carry confirm on a promote and nothing on a list', () => {
    const promote = { action: 'promote', branchId: 'draft', confirm: true };
    expect(routeFor(promote).translate(promote)).toEqual({ branch: 'draft', confirm: true });
    const list = { action: 'list' };
    expect(routeFor(list).translate(list)).toEqual({});
  });
});
