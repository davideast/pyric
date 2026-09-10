import type { Sandbox } from 'pyric/sandbox';
import { SandboxClock } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { DataTree } from './data-tree.js';
import type { ChildListener, ValueListener } from './listener-types.js';
import { MutationHistory } from './mutation-history.js';
import { OperationEvents } from './operation-events.js';
import { PriorityState } from './priority-state.js';
import { RulesEvaluator } from './rules-eval.js';

export class BackendState {
  readonly tree = new DataTree();
  readonly rules: RulesEvaluator;
  activeRules: { rules: Record<string, unknown> } | null = null;
  readonly valueListeners = new Set<ValueListener>();
  readonly childListeners = new Set<ChildListener>();
  readonly priorities = new PriorityState();
  readonly mutations = new MutationHistory();
  readonly events: OperationEvents;
  readonly writeSubscribers = new Set<() => void>();
  resetGeneration = 0;
  /**
   * The sandbox's clock. Every server-set time this backend produces reads it:
   * `ServerValue.TIMESTAMP`, the rules engine's `now`, push-id keys, and the
   * operation-event stamps. A backend with no sandbox keeps its own wall clock.
   */
  readonly clock: SandboxClock;

  constructor(sandbox?: Sandbox) {
    this.events = new OperationEvents(sandbox);
    this.clock = sandbox ? getClock(sandbox) : new SandboxClock();
    this.rules = new RulesEvaluator(this.clock);
  }

  notifyWrite(): void {
    for (const subscriber of this.writeSubscribers) {
      try { subscriber(); } catch { /* persistence scheduling is observational */ }
    }
  }
}
