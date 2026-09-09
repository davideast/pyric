/**
 * The routes the `dry_run_experiment` tool's actions take.
 *
 * The branch lifecycle, behind the tool whose discriminator already spelled
 * it: fork, apply, diff, promote, discard, list. Each route is the same
 * canonical operation the service tool's branch methods reach, under the
 * argument names this variant was authored with.
 */
import type { Args, DiscriminatorRoute } from './discriminator-route-shapes.js';
import { assign, on, parseJsonArray, text } from './discriminator-route-shapes.js';

export const BRANCH_ROUTES: DiscriminatorRoute[] = [
  {
    tool: 'dry_run_experiment',
    action: 'fork',
    selects: on('action', 'fork'),
    operation: 'fork_sandbox_branch',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'branch', args.branchId);
      assign(call, 'candidateRules', args.candidateRules);
      return call;
    },
  },
  {
    tool: 'dry_run_experiment',
    action: 'apply',
    selects: on('action', 'apply'),
    operation: 'apply_sandbox_events',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'branch', args.branchId);
      assign(call, 'events', parseJsonArray(text(args, 'mutationsJson')));
      return call;
    },
  },
  {
    tool: 'dry_run_experiment',
    action: 'diff',
    selects: on('action', 'diff'),
    operation: 'diff_sandbox_branch',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'branch', args.branchId);
      assign(call, 'against', args.against);
      return call;
    },
  },
  {
    tool: 'dry_run_experiment',
    action: 'promote',
    selects: on('action', 'promote'),
    operation: 'promote_sandbox_branch',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'branch', args.branchId);
      assign(call, 'confirm', args.confirm);
      return call;
    },
  },
  {
    tool: 'dry_run_experiment',
    action: 'discard',
    selects: on('action', 'discard'),
    operation: 'discard_sandbox_branch',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'branch', args.branchId);
      return call;
    },
  },
  {
    tool: 'dry_run_experiment',
    action: 'list',
    selects: on('action', 'list'),
    operation: 'list_sandbox_branches',
    translate: () => ({}),
  },
];
