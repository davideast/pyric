/**
 * The routes the `control_sandbox_environment` tool's actions take.
 *
 * This is sandbox state as the discriminator variant spells it: clearing it,
 * seeding it, saving, restoring, and discarding a checkpoint, paging the log, and
 * writing or loading a fixture. Each route is the same canonical operation the
 * service tool's `sandbox` methods reach, under the argument names this
 * variant was authored with.
 */
import type { Args, DiscriminatorRoute } from './discriminator-route-shapes.js';
import { assign, on, parseJsonObject, text } from './discriminator-route-shapes.js';

export const SANDBOX_STATE_ROUTES: DiscriminatorRoute[] = [
  {
    tool: 'control_sandbox_environment',
    action: 'reset_all',
    selects: on('action', 'reset_all'),
    operation: 'reset_sandbox',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'scope', args.scope);
      assign(call, 'confirm', args.confirm);
      return call;
    },
  },
  {
    tool: 'control_sandbox_environment',
    action: 'set_clock',
    selects: on('action', 'set_clock'),
    operation: 'set_clock',
    translate: (args) => ({ isoTime: args.targetTimestampIso }),
  },
  {
    tool: 'control_sandbox_environment',
    action: 'advance_clock',
    selects: on('action', 'advance_clock'),
    operation: 'advance_clock',
    translate: (args) => ({ ms: args.advanceMs }),
  },
  {
    tool: 'control_sandbox_environment',
    action: 'reset_clock',
    selects: on('action', 'reset_clock'),
    operation: 'reset_clock',
    translate: () => ({}),
  },
  {
    tool: 'control_sandbox_environment',
    action: 'seed',
    selects: on('action', 'seed'),
    operation: 'seed_sandbox',
    translate: (args) => parseJsonObject(text(args, 'seedSnapshotJson')) ?? {},
  },
  // Step 3A: sandbox state management (checkpoints, events, fixtures).
  {
    tool: 'control_sandbox_environment',
    action: 'checkpoint',
    selects: on('action', 'checkpoint'),
    operation: 'checkpoint_sandbox',
    translate: (args) => ({ name: args.checkpointName }),
  },
  {
    tool: 'control_sandbox_environment',
    action: 'restore',
    selects: on('action', 'restore'),
    operation: 'restore_sandbox',
    translate: (args) => {
      const call: Args = { name: args.checkpointName };
      assign(call, 'confirm', args.confirm);
      return call;
    },
  },
  {
    tool: 'control_sandbox_environment',
    action: 'list_checkpoints',
    selects: on('action', 'list_checkpoints'),
    operation: 'list_sandbox_checkpoints',
    translate: () => ({}),
  },
  {
    tool: 'control_sandbox_environment',
    action: 'delete_checkpoint',
    selects: on('action', 'delete_checkpoint'),
    operation: 'delete_sandbox_checkpoint',
    translate: (args) => {
      const call: Args = { name: args.checkpointName };
      assign(call, 'confirm', args.confirm);
      return call;
    },
  },
  {
    tool: 'control_sandbox_environment',
    action: 'events',
    selects: on('action', 'events'),
    operation: 'list_sandbox_events',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'since', args.since);
      assign(call, 'limit', args.limit);
      assign(call, 'kind', args.kind);
      return call;
    },
  },
  {
    tool: 'control_sandbox_environment',
    action: 'listeners',
    selects: on('action', 'listeners'),
    operation: 'list_sandbox_listeners',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'service', args.service);
      assign(call, 'target', args.target);
      return call;
    },
  },
  {
    tool: 'control_sandbox_environment',
    action: 'activity',
    selects: on('action', 'activity'),
    operation: 'list_sandbox_activity',
    translate: (args) => {
      const call: Args = {};
      assign(call, 'since', args.since);
      assign(call, 'pattern', args.pattern);
      return call;
    },
  },
  {
    tool: 'control_sandbox_environment',
    action: 'export_fixture',
    selects: on('action', 'export_fixture'),
    operation: 'export_sandbox_fixture',
    translate: (args) => {
      const call: Args = { path: args.fixturePath };
      assign(call, 'excludePasswords', args.excludePasswords);
      return call;
    },
  },
  {
    tool: 'control_sandbox_environment',
    action: 'seed_fixture',
    selects: on('action', 'seed_fixture'),
    operation: 'seed_sandbox_fixture',
    translate: (args) => ({ path: args.fixturePath }),
  },
];
