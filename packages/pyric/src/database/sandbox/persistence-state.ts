import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import type { JsonValue } from './data-tree.js';
import type { Priority } from './query.js';
import type { ValueListeners } from './value-listeners.js';

function decode(root: JsonValue): {
  data: JsonValue;
  priorities: Record<string, Exclude<Priority, null>>;
  rules: { rules: Record<string, unknown> } | null;
} {
  const isNotNull = root !== null;
  let isObject = false;
  if (isNotNull) {
    const isObjectType = typeof root === 'object';
    const isArrayType = Array.isArray(root);
    if (isObjectType) {
      if (!isArrayType) {
        isObject = true;
      }
    }
  }

  if (isObject) {
    const candidate = root as Record<string, JsonValue>;
    const marker = candidate['.pyricRtdbPersistence'];
    const hasMarker = marker === 1;
    const hasDataKey = 'data' in candidate;

    let isEnvelope = false;
    if (hasMarker) {
      if (hasDataKey) {
        isEnvelope = true;
      }
    }

    const encoded = candidate.priorities;
    const isEncodedNotNull = encoded !== null;
    const isEncodedDefined = encoded !== undefined;
    let isEncodedObject = false;
    if (isEncodedNotNull) {
      if (isEncodedDefined) {
        const isEncodedObjectType = typeof encoded === 'object';
        const isEncodedArrayType = Array.isArray(encoded);
        if (isEncodedObjectType) {
          if (!isEncodedArrayType) {
            isEncodedObject = true;
          }
        }
      }
    }

    let isValidEnvelope = false;
    if (isEnvelope) {
      if (isEncodedObject) {
        isValidEnvelope = true;
      }
    }

    if (isValidEnvelope) {
      const priorities: Record<string, Exclude<Priority, null>> = {};
      const entries = Object.entries(encoded as Record<string, JsonValue>);
      for (const [path, priority] of entries) {
        const isString = typeof priority === 'string';
        const isNumber = typeof priority === 'number';
        let isFiniteNumber = false;
        if (isNumber) {
          const isFiniteVal = Number.isFinite(priority);
          if (isFiniteVal) {
            isFiniteNumber = true;
          }
        }
        let isValidPriority = false;
        if (isString) {
          isValidPriority = true;
        }
        if (isFiniteNumber) {
          isValidPriority = true;
        }
        if (isValidPriority) {
          priorities[path] = priority as Exclude<Priority, null>;
        }
      }

      const rawData = candidate.data;
      let dataVal: JsonValue = null;
      const isDataDefined = rawData !== undefined;
      if (isDataDefined) {
        const isDataNotNull = rawData !== null;
        if (isDataNotNull) {
          dataVal = rawData;
        }
      }

      const rawRules = candidate.rules;
      let rulesVal: { rules: Record<string, unknown> } | null = null;
      const isRulesDefined = rawRules !== undefined;
      if (isRulesDefined) {
        const isRulesNotNull = rawRules !== null;
        if (isRulesNotNull) {
          const isRulesObjectType = typeof rawRules === 'object';
          const isRulesArrayType = Array.isArray(rawRules);
          let isRulesValidObject = false;
          if (isRulesObjectType) {
            if (!isRulesArrayType) {
              isRulesValidObject = true;
            }
          }
          if (isRulesValidObject) {
            const rulesCandidate = rawRules as Record<string, unknown>;
            const hasRulesProp = 'rules' in rulesCandidate;
            if (hasRulesProp) {
              const innerRules = rulesCandidate.rules;
              const isInnerNotNull = innerRules !== null;
              const isInnerDefined = innerRules !== undefined;
              if (isInnerNotNull) {
                if (isInnerDefined) {
                  const isInnerObject = typeof innerRules === 'object';
                  const isInnerArray = Array.isArray(innerRules);
                  let isInnerValid = false;
                  if (isInnerObject) {
                    if (!isInnerArray) {
                      isInnerValid = true;
                    }
                  }
                  if (isInnerValid) {
                    rulesVal = { rules: innerRules as Record<string, unknown> };
                  }
                }
              }
            }
          }
        }
      }

      return { data: dataVal, priorities, rules: rulesVal };
    }
  }

  return { data: root, priorities: {}, rules: null };
}

export class PersistenceState {
  constructor(
    private readonly state: BackendState,
    private readonly values: ValueListeners,
    private readonly children: ChildListeners,
  ) {}

  exportTree(): JsonValue {
    return this.state.tree.snapshot();
  }

  exportState(): JsonValue {
    const hasActiveRules = this.state.activeRules !== null;
    const state: Record<string, JsonValue> = {
      '.pyricRtdbPersistence': 1,
      data: this.state.tree.snapshot(),
      priorities: Object.fromEntries(this.state.priorities.entries()) as JsonValue,
    };
    if (hasActiveRules) {
      state.rules = structuredClone(this.state.activeRules) as unknown as JsonValue;
    }
    return state as unknown as JsonValue;
  }

  restore(root: JsonValue): void {
    const priors = this.children.snapshotParents();
    const persisted = decode(root);

    let dataToRestore: JsonValue = {};
    const isPersistedDataNull = persisted.data === null;
    const isPersistedDataUndefined = persisted.data === undefined;
    let hasPersistedData = false;
    if (!isPersistedDataNull) {
      if (!isPersistedDataUndefined) {
        hasPersistedData = true;
      }
    }
    if (hasPersistedData) {
      dataToRestore = persisted.data;
    }

    const hasPersistedRules = persisted.rules !== null;
    if (hasPersistedRules) {
      this.state.rules.setRules(persisted.rules);
      this.state.activeRules = structuredClone(persisted.rules);
    } else {
      this.state.rules.setRules(null);
      this.state.activeRules = null;
    }

    this.state.tree.restore(dataToRestore);
    this.state.priorities.restore(persisted.priorities);
    this.state.mutations.mark('/');
    this.values.fanOut(['/']);
    this.children.fanOut(priors);
  }

  reset(): void {
    this.state.resetGeneration += 1;
    this.restore(null);
  }

  subscribe(onChange: () => void): () => void {
    this.state.writeSubscribers.add(onChange);
    return () => { this.state.writeSubscribers.delete(onChange); };
  }
}
