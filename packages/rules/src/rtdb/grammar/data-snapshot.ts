/**
 * Realtime Database `DataSnapshot` runtime model and runtime error class for
 * local security rules evaluation.
 *
 * When an optional `SnapshotReadObserver` is supplied, every leaf or subtree
 * inspection (`val`, `exists`, zero-arg `hasChildren`, `isString`, `isNumber`,
 * `isBoolean`, `getPriority`) reports the snapshot's canonical path. Navigation
 * (`child`, `parent`) propagates the observer without reporting intermediate
 * containers, so `hasChild('a')` and `hasChildren(['a', 'b'])` report only the
 * child paths actually inspected.
 */

export type SnapshotReadObserver = (path: string) => void;

/** Whether `raw` is a JSON object node, as opposed to a leaf or null. */
function isObjectNode(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/**
 * A node's value as rules read it through `val()`: a `{ .value, .priority }`
 * node reads as its `.value`, and `.priority` keys are dropped at every
 * level, so a priority never shows up as data (capture rules-rtdb-r20). An
 * object left with no children reads as null.
 */
function exportedValue(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < raw.length; i++) {
      if (!(i in raw)) continue;
      const value = exportedValue(raw[i]);
      if (value !== null) out[String(i)] = value;
    }
    return Object.keys(out).length === 0 ? null : out;
  }
  if (!isObjectNode(raw)) return raw ?? null;
  if (Object.hasOwn(raw, '.value')) return exportedValue(raw['.value']);
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(raw)) {
    if (key === '.priority') continue;
    const value = exportedValue(child);
    // Defined, not assigned: assigning a key named `__proto__` runs the
    // prototype setter and drops it, where production keeps it (CS-1).
    if (value !== null) Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** A node's priority: its `.priority` number or string when the node exists, else null. */
function priorityOf(raw: unknown): number | string | null {
  if (!isObjectNode(raw) || exportedValue(raw) === null) return null;
  const priority = raw['.priority'];
  const isPriority = typeof priority === 'number' || typeof priority === 'string';
  return isPriority ? priority : null;
}

export class DataSnapshot {
  private _value: unknown;
  private _path: string;
  private _root: unknown;
  private _onRead?: SnapshotReadObserver;

  constructor(value: unknown, path: string = '/', root?: unknown, onRead?: SnapshotReadObserver) {
    this._value = value ?? null;
    this._path = path;
    this._root = root !== undefined ? root : value;
    this._onRead = onRead;
  }

  val(): unknown {
    this._onRead?.(this._path);
    return exportedValue(this._value);
  }

  exists(): boolean {
    return this.val() !== null;
  }

  hasChild(path: string): boolean {
    return this.child(path).exists();
  }

  hasChildren(keys?: readonly string[]): boolean {
    // `hasChildren(['a', 'b'])` — true only when EVERY listed key is
    // present (prod semantics). `hasChildren()` — true when the node has
    // at least one child.
    if (keys !== undefined) {
      return keys.every((key) => this.hasChild(key));
    }
    return isObjectNode(this.val());
  }

  isString(): boolean {
    return typeof this.val() === 'string';
  }

  isNumber(): boolean {
    return typeof this.val() === 'number';
  }

  isBoolean(): boolean {
    return typeof this.val() === 'boolean';
  }

  child(path: string): DataSnapshot {
    const parts = path.split('/').filter(p => p.length > 0);
    if (parts.length === 0) return this;

    let current: unknown = this._value;
    for (const part of parts) {
      if (part === '.value') {
        current = null;
        break;
      }
      if (part === '.priority') {
        current = priorityOf(current);
        continue;
      }
      while (isObjectNode(current) && Object.hasOwn(current, '.value')) {
        current = current['.value'];
      }
      if (Array.isArray(current)) {
        const idx = Number(part);
        current =
          Number.isInteger(idx) && idx >= 0 && idx < current.length && String(idx) === part && idx in current
            ? (current[idx] ?? null)
            : null;
      } else if (isObjectNode(current)) {
        current = Object.hasOwn(current, part)
          ? (current[part] ?? null)
          : null;
      } else {
        current = null;
      }
    }

    const prefix = this._path === '/' ? '' : this._path;
    const currentPath = `${prefix}/${parts.join('/')}`;
    return new DataSnapshot(current, currentPath, this._root, this._onRead);
  }

  parent(): DataSnapshot {
    if (this._path === '/') throw new RtdbRuleRuntimeError('Cannot call parent() on root.');
    const parts = this._path.split('/').filter(p => p.length > 0);
    parts.pop();
    const rootSnap = new DataSnapshot(this._root, '/', this._root, this._onRead);
    if (parts.length === 0) return rootSnap;
    return rootSnap.child(parts.join('/'));
  }

  getPriority(): number | string | null {
    this._onRead?.(this._path);
    return priorityOf(this._value);
  }
}

/**
 * A failure the production rules engine also raises while it evaluates a rule:
 * a rules method called on a value whose runtime type does not have it, such
 * as `toUpperCase()` on a number or on null. Production fails the whole rule
 * expression on it, with no short-circuit rescue from `||` or `!`, and treats
 * the rule as not granting (captures rules-rtdb-r17 and rules-rtdb-r26).
 *
 * Any other throw from the evaluator, such as a method that is not part of the
 * RTDB rules language, is a construct the simulator does not evaluate and is
 * not this error.
 */
export class RtdbRuleRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RtdbRuleRuntimeError';
  }
}
