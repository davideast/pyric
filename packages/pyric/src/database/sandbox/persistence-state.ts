import type { BackendState } from './backend-state.js';
import type { ChildListeners } from './child-listeners.js';
import { isJsonObject, joinPath, pathSegments, setOwnProperty, type JsonValue } from './data-tree.js';
import type { Priority } from './query.js';
import type { ValueListeners } from './value-listeners.js';
import { WritePlane } from './write-plane.js';

function asValidPriority(value: unknown): Exclude<Priority, null> | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

const UNSAFE_PRIORITY_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function canStorePriorityForSegments(segments: readonly string[]): boolean {
  return segments[0] !== '.info' && !segments.some((seg) => UNSAFE_PRIORITY_SEGMENTS.has(seg));
}

function normalizeRestoredNode(
  value: unknown,
  segments: readonly string[],
  inlinePriorities: Record<string, Exclude<Priority, null>>,
): JsonValue {
  if (value === null || value === undefined) return null;
  if (value === 0) return 0;
  if (typeof value !== 'object') return value as JsonValue;

  if (Array.isArray(value)) {
    const out: Record<string, JsonValue> = {};
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) continue;
      const key = String(i);
      const child = normalizeRestoredNode(value[i], [...segments, key], inlinePriorities);
      if (child === null) continue;
      out[key] = child;
    }
    return Object.keys(out).length === 0 ? null : out;
  }

  const record = value as Record<string, unknown>;
  const inlinePriority = Object.hasOwn(record, '.priority') ? asValidPriority(record['.priority']) : null;

  if (Object.hasOwn(record, '.value')) {
    const normalized = normalizeRestoredNode(record['.value'], segments, inlinePriorities);
    if (normalized !== null && inlinePriority !== null && canStorePriorityForSegments(segments)) {
      setOwnProperty(inlinePriorities, joinPath([...segments]), inlinePriority);
    }
    return normalized;
  }

  const out: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === '.priority') continue;
    if (key === '.sv') {
      setOwnProperty(out, key, child as JsonValue);
      continue;
    }
    const normalized = normalizeRestoredNode(child, [...segments, key], inlinePriorities);
    if (normalized === null) continue;
    setOwnProperty(out, key, normalized);
  }
  if (Object.keys(out).length === 0) return null;
  if (inlinePriority !== null && canStorePriorityForSegments(segments)) {
    setOwnProperty(inlinePriorities, joinPath([...segments]), inlinePriority);
  }
  return out;
}

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
          setOwnProperty(priorities, path, priority as Exclude<Priority, null>);
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
  private readonly writes: WritePlane;

  constructor(
    private readonly state: BackendState,
    private readonly values: ValueListeners,
    private readonly children: ChildListeners,
  ) {
    this.writes = new WritePlane(state, values, children);
  }

  exportTree(): JsonValue {
    return this.state.tree.snapshot();
  }

  exportState(): JsonValue {
    const hasActiveRules = this.state.activeRules !== null;
    const state: Record<string, JsonValue> = {
      '.pyricRtdbPersistence': 1,
      data: this.state.tree.snapshot(),
      priorities: Object.fromEntries(this.state.priorities.entries()),
    };
    if (hasActiveRules) {
      state.rules = structuredClone(this.state.activeRules) as JsonValue;
    }
    return state;
  }

  restore(root: JsonValue): void {
    this.state.resetGeneration += 1;
    const priors = this.children.snapshotParents();
    const persisted = decode(root);

    const inlinePriorities: Record<string, Exclude<Priority, null>> = {};
    const normalizedData = normalizeRestoredNode(persisted.data, [], inlinePriorities);
    const dataToRestore: JsonValue = normalizedData === null ? {} : normalizedData;
    const mergedPriorities: Record<string, Exclude<Priority, null>> = { ...inlinePriorities };
    for (const [path, priority] of Object.entries(persisted.priorities)) {
      setOwnProperty(mergedPriorities, path, priority);
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
    const validPriorities: Record<string, Exclude<Priority, null>> = {};
    for (const [path, priority] of Object.entries(mergedPriorities)) {
      const segs = pathSegments(path);
      if (!canStorePriorityForSegments(segs)) continue;
      const storedNode = this.state.tree.peekSegments(segs);
      const hasStoredValue =
        storedNode !== undefined
        && storedNode !== null
        && !(isJsonObject(storedNode) && Object.keys(storedNode).length === 0);
      if (hasStoredValue) {
        setOwnProperty(validPriorities, joinPath(segs), priority);
      }
    }
    this.state.priorities.restore(validPriorities);
    this.state.mutations.mark('/');
    this.writes.cancelDeniedListeners();
    this.writes.fanOutAll(['/'], priors);
  }

  reset(preserveRules = false): void {
    this.state.resetGeneration += 1;
    const priors = this.children.snapshotParents();
    this.state.tree.restore({});
    this.state.priorities.restore({});
    this.state.mutations.mark('/');
    if (!preserveRules) {
      this.state.rules.setRules(null);
      this.state.activeRules = null;
    }
    this.writes.cancelDeniedListeners();
    this.writes.fanOutAll(['/'], priors);
  }

  subscribe(onChange: () => void): () => void {
    this.state.writeSubscribers.add(onChange);
    return () => { this.state.writeSubscribers.delete(onChange); };
  }
}
