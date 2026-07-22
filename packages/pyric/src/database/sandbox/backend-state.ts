import type { Sandbox } from 'pyric/sandbox';
import { DataTree } from './data-tree.js';
import type { ChildListener, ValueListener } from './listener-types.js';
import { MutationHistory } from './mutation-history.js';
import { OperationEvents } from './operation-events.js';
import { PriorityState } from './priority-state.js';
import { RulesEvaluator } from './rules-eval.js';

export class BackendState {
  readonly tree = new DataTree();
  readonly rules = new RulesEvaluator();
  activeRules: { rules: Record<string, unknown> } | null = null;
  readonly valueListeners = new Set<ValueListener>();
  readonly childListeners = new Set<ChildListener>();
  readonly priorities = new PriorityState();
  readonly mutations = new MutationHistory();
  readonly events: OperationEvents;
  readonly writeSubscribers = new Set<() => void>();
  resetGeneration = 0;

  constructor(sandbox?: Sandbox) {
    this.events = new OperationEvents(sandbox);
  }

  notifyWrite(): void {
    for (const subscriber of this.writeSubscribers) {
      try { subscriber(); } catch { /* persistence scheduling is observational */ }
    }
  }
}
