// Isomorphic simulator bridges for Firestore, unified RTDB, and Firebase Storage Rules v2.
// Pre-compiles lowered predicates once for fast scenario replay, fuzzing, and split-proof checks.
// Zero Node-only imports (pure ECMAScript / WinterCG compatible).
import { firestoreRules } from '../api/firestore.js';
import { rtdbRules } from '../api/rtdb.js';
import { storageRules } from '../api/storage.js';
import type { StorageCase } from '../api/case-types.js';
import type { CheckedPolicyIR } from './check.js';
import { revivePolicyValue } from './eval-ir.js';
import type { FirestoreBindings } from './firestore.js';
import type { Transition } from './index.js';
import type { RtdbBinding, RtdbBindings, RtdbSnapshotBinding } from './rtdb.js';
import type { StorageBindings } from './storage.js';

export type StorageSimMethod = 'create' | 'update' | 'delete';
export type TargetDecision = 'ALLOW' | 'DENY';

const STORAGE_PROOF_BUCKET = 'pyric-policy-proof.appspot.com';
const SUPPORTED_FS_BINDING =
  /^(?:resource\.data(?:\.[A-Za-z_][A-Za-z0-9_]*)*|request\.resource\.data(?:\.[A-Za-z_][A-Za-z0-9_]*)*|request\.auth(?:\.uid|\.token(?:\.[A-Za-z_][A-Za-z0-9_]*)+)?|true|false)$/;
const SUPPORTED_STORAGE_BINDING =
  /^(?:resource(?:\.[A-Za-z_][A-Za-z0-9_]*)*|request\.resource(?:\.[A-Za-z_][A-Za-z0-9_]*)*|request\.auth(?:\.uid|\.token(?:\.[A-Za-z_][A-Za-z0-9_]*)+)?|request\.method|true|false|[A-Za-z_][A-Za-z0-9_]*)$/;
const RTDB_KEY_SEG = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const FORBIDDEN_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setNestedPath(target: Record<string, unknown>, segments: readonly string[], value: unknown): boolean {
  let cur = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (FORBIDDEN_PATH_KEYS.has(seg)) return false;
    const existing = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
    if (!isPlainRecord(existing)) {
      const next: Record<string, unknown> = {};
      Object.defineProperty(cur, seg, { value: next, enumerable: true, writable: true, configurable: true });
      cur = next;
    } else cur = existing;
  }
  const last = segments[segments.length - 1];
  if (!last || FORBIDDEN_PATH_KEYS.has(last)) return false;
  Object.defineProperty(cur, last, { value, enumerable: true, writable: true, configurable: true });
  return true;
}

function readNested(root: unknown, segments: readonly string[]): { present: boolean; value: unknown } {
  let cur: unknown = root;
  for (const seg of segments) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, seg)) {
      return { present: false, value: undefined };
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { present: true, value: cur };
}

function readTransitionPath(transition: Transition, policyPath: string): { present: boolean; value: unknown } {
  const [root, ...rest] = policyPath.split('.');
  const rootObj =
    root === 'before' ? transition.before : root === 'after' ? transition.after : root === 'input' ? transition.input : undefined;
  if (!rest.length) return { present: rootObj !== undefined, value: rootObj };
  return readNested(rootObj, rest);
}

function hasNonJsonNumber(value: unknown, depth = 0): boolean {
  if (depth > 16 || value === null || value === undefined) return false;
  if (typeof value === 'number') return Object.is(value, -0) || !Number.isFinite(value);
  if (typeof value === 'bigint') return true;
  if (Array.isArray(value)) return value.some((v) => hasNonJsonNumber(v, depth + 1));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => hasNonJsonNumber(v, depth + 1));
  }
  return false;
}

/** True when a nested RTDB value contains null or empty containers stripped on wire. */
function hasUnrepresentableRtdbValue(value: unknown, isRoot: boolean, depth = 0): boolean {
  if (depth > 16) return true;
  if (value === undefined) return !isRoot;
  if (value === null) return !isRoot;
  if (typeof value === 'number') return Object.is(value, -0) || !Number.isFinite(value);
  if (typeof value === 'bigint') return true;
  if (typeof value === 'boolean' || typeof value === 'string') return false;
  if (Array.isArray(value)) {
    if (value.length === 0) return true;
    return value.some((item) => hasUnrepresentableRtdbValue(item, false, depth + 1));
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return !isRoot;
    return keys.some((k) => hasUnrepresentableRtdbValue(value[k], false, depth + 1));
  }
  return true;
}

function normalizeRtdbBinding(binding: RtdbBinding): RtdbSnapshotBinding | undefined {
  if (binding === 'data' || binding === 'newData') return { snapshot: binding };
  if (!binding || typeof binding !== 'object') return undefined;
  if (binding.snapshot !== 'data' && binding.snapshot !== 'newData') return undefined;
  if (binding.parent !== undefined && typeof binding.parent !== 'boolean') return undefined;
  if (binding.path !== undefined) {
    if (typeof binding.path !== 'string' || !binding.path.length) return undefined;
    if (!binding.path.split('/').every((p) => RTDB_KEY_SEG.test(p))) return undefined;
  }
  if (binding.type !== undefined && !['number', 'string', 'boolean', 'any'].includes(binding.type)) {
    return undefined;
  }
  return binding;
}

function buildAuthFromEntries(
  entries: readonly (readonly [string, string])[],
  transition: Transition,
  reviveValues: boolean,
): { ok: true; auth: { uid: string; token?: Record<string, unknown> } | null } | { ok: false } {
  let uid: unknown;
  let uidPresent = false;
  let bareAuthSeen = false;
  let bareAuthNull = false;
  const token: Record<string, unknown> = {};
  let hasToken = false;
  for (const [policyPath, target] of entries) {
    if (target === 'request.auth.uid') {
      const r = readTransitionPath(transition, policyPath);
      uidPresent = r.present;
      uid = r.value;
    } else if (target.startsWith('request.auth.token.')) {
      const r = readTransitionPath(transition, policyPath);
      if (r.present) {
        const val = reviveValues ? revivePolicyValue(r.value) : r.value;
        if (!setNestedPath(token, target.slice('request.auth.token.'.length).split('.'), val)) return { ok: false };
        hasToken = true;
      }
    } else if (target === 'request.auth') {
      bareAuthSeen = true;
      const r = readTransitionPath(transition, policyPath);
      if (!r.present) return { ok: false };
      if (r.value === null) {
        bareAuthNull = true;
      } else if (isPlainRecord(r.value)) {
        if (typeof r.value.uid !== 'string') return { ok: false };
        uidPresent = true;
        uid = r.value.uid;
        if (r.value.token !== undefined) {
          if (!isPlainRecord(r.value.token)) return { ok: false };
          Object.assign(token, reviveValues ? (revivePolicyValue(r.value.token) as Record<string, unknown>) : r.value.token);
          hasToken = true;
        }
      } else {
        return { ok: false };
      }
    }
  }
  if (uidPresent && typeof uid !== 'string') return { ok: false };
  if (typeof uid === 'string') return { ok: true, auth: hasToken ? { uid, token } : { uid } };
  if (bareAuthSeen && bareAuthNull) return { ok: true, auth: null };
  if (hasToken) return { ok: true, auth: { uid: '', token } };
  return { ok: true, auth: null };
}

function makeFirestoreRunner(
  rules: ReturnType<typeof firestoreRules>,
  entries: readonly (readonly [string, string])[],
): (transition: Transition) => TargetDecision | undefined {
  const hasAuthBinding = entries.some(([, target]) => target === 'request.auth' || target.startsWith('request.auth.'));
  return (transition: Transition) => {
    let resource: Record<string, unknown> = {};
    let data: Record<string, unknown> = {};
    let hasResourceBinding = false;
    let hasDataBinding = false;
    try {
      for (const [policyPath, target] of entries) {
        if (target === 'true' || target === 'false') {
          const r = readTransitionPath(transition, policyPath);
          if (!r.present || r.value !== (target === 'true')) return undefined;
          continue;
        }
        if (target === 'resource.data') {
          hasResourceBinding = true;
          const r = readTransitionPath(transition, policyPath);
          if (r.present && isPlainRecord(r.value)) resource = revivePolicyValue(r.value) as Record<string, unknown>;
        } else if (target.startsWith('resource.data.')) {
          hasResourceBinding = true;
          const r = readTransitionPath(transition, policyPath);
          if (r.present && !setNestedPath(resource, target.slice('resource.data.'.length).split('.'), revivePolicyValue(r.value))) return undefined;
        } else if (target === 'request.resource.data') {
          hasDataBinding = true;
          const r = readTransitionPath(transition, policyPath);
          if (r.present && isPlainRecord(r.value)) data = revivePolicyValue(r.value) as Record<string, unknown>;
        } else if (target.startsWith('request.resource.data.')) {
          hasDataBinding = true;
          const r = readTransitionPath(transition, policyPath);
          if (r.present && !setNestedPath(data, target.slice('request.resource.data.'.length).split('.'), revivePolicyValue(r.value))) return undefined;
        }
      }
      if (!hasResourceBinding && isPlainRecord(transition.before)) {
        resource = revivePolicyValue(transition.before) as Record<string, unknown>;
      }
      if (!hasDataBinding && isPlainRecord(transition.after)) {
        data = revivePolicyValue(transition.after) as Record<string, unknown>;
      }
      let auth: { uid: string; token?: Record<string, unknown> } | null | undefined;
      if (hasAuthBinding) {
        const built = buildAuthFromEntries(entries, transition, true);
        if (!built.ok) return undefined;
        auth = built.auth;
      }
      const [row] = rules.simulate([
        {
          description: 'provePolicy',
          method: 'update',
          path: 'items/one',
          resource,
          data,
          ...(hasAuthBinding ? { auth } : {}),
          expectation: 'ALLOW',
        },
      ]).cases;
      if (!row || row.unsupported) return undefined;
      return row.decision === 'ALLOW' || row.decision === 'DENY' ? row.decision : undefined;
    } catch {
      return undefined;
    }
  };
}

export function isSupportedFirestoreBindings(bindings: FirestoreBindings): boolean {
  return Object.values(bindings).every((target) => SUPPORTED_FS_BINDING.test(target));
}

/** Pre-compile a lowered Firestore module once for fast scenario + fuzz replay. */
export function createFirestoreEvaluator(
  moduleSource: string,
  fnName: string,
  bindings: FirestoreBindings,
): ((transition: Transition) => TargetDecision | undefined) | undefined {
  const entries = Object.entries(bindings);
  if (entries.some(([, target]) => !SUPPORTED_FS_BINDING.test(target))) return undefined;
  const body = moduleSource.slice(moduleSource.indexOf('export function') + 'export '.length);
  const rules = firestoreRules(`rules_version = '2'; service cloud.firestore {
    match /databases/{db}/documents {
      ${body}
      match /items/{id} { allow update: if ${fnName}(); }
    }
  }`);
  return makeFirestoreRunner(rules, entries);
}

/** Pre-compile a list of lowered Firestore predicates (supports partial/split enforcement). */
export function createFirestorePredicateEvaluator(
  predicates: readonly string[],
  bindings: FirestoreBindings,
): ((transition: Transition) => TargetDecision | undefined) | undefined {
  if (!predicates.length) return undefined;
  const entries = Object.entries(bindings);
  if (entries.some(([, target]) => !SUPPORTED_FS_BINDING.test(target))) return undefined;
  const expr = predicates.length === 1 ? predicates[0]! : predicates.map((p) => `(${p})`).join(' && ');
  try {
    const rules = firestoreRules(`rules_version = '2'; service cloud.firestore {
      match /databases/{db}/documents {
        match /items/{id} { allow update: if ${expr}; }
      }
    }`);
    return makeFirestoreRunner(rules, entries);
  } catch {
    return undefined;
  }
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildRtdbSlotValue(
  items: readonly { policyPath: string; binding: RtdbSnapshotBinding }[],
  transition: Transition,
  keepKey: string | undefined,
): { ok: true; present: boolean; value: unknown } | { ok: false } {
  if (!items.length) return { ok: true, present: false, value: undefined };
  const roots = items.filter((i) => !i.binding.path);
  const paths = items.filter((i) => Boolean(i.binding.path));
  if (roots.length && paths.length) return { ok: false };
  if (roots.length) {
    let chosen: { present: boolean; value: unknown } | undefined;
    for (const item of roots) {
      const r = readTransitionPath(transition, item.policyPath);
      if (r.present && hasUnrepresentableRtdbValue(r.value, true)) return { ok: false };
      if (!chosen) chosen = r;
      else if (chosen.present !== r.present || !deepEqualJson(chosen.value, r.value)) return { ok: false };
    }
    if (!chosen || !chosen.present) return { ok: true, present: false, value: undefined };
    if (isPlainRecord(chosen.value) && Object.keys(chosen.value).length === 0 && keepKey) {
      return { ok: true, present: true, value: { [keepKey]: true } };
    }
    return { ok: true, present: true, value: chosen.value };
  }
  const map: Record<string, unknown> = {};
  let anyPresent = false;
  for (const item of paths) {
    const r = readTransitionPath(transition, item.policyPath);
    if (!r.present) continue;
    if (hasUnrepresentableRtdbValue(r.value, false)) return { ok: false };
    if (!setNestedPath(map, item.binding.path!.split('/'), r.value)) return { ok: false };
    anyPresent = true;
  }
  if (!anyPresent) return { ok: true, present: false, value: undefined };
  return { ok: true, present: true, value: map };
}

/** Pre-compile unified RTDB `.write` predicates (supports legacy, root, path, typed, and parent bindings). */
export function createRtdbEvaluator(
  predicates: readonly string[],
  bindings: RtdbBindings,
): ((transition: Transition) => TargetDecision | undefined) | undefined {
  if (!predicates.length) return undefined;
  const dataNode: { policyPath: string; binding: RtdbSnapshotBinding }[] = [];
  const newNode: { policyPath: string; binding: RtdbSnapshotBinding }[] = [];
  const dataParent: { policyPath: string; binding: RtdbSnapshotBinding }[] = [];
  const newParent: { policyPath: string; binding: RtdbSnapshotBinding }[] = [];
  for (const [policyPath, raw] of Object.entries(bindings)) {
    const binding = normalizeRtdbBinding(raw);
    if (!binding) return undefined;
    const entry = { policyPath, binding };
    if (binding.parent) {
      if (!binding.path) return undefined;
      (binding.snapshot === 'data' ? dataParent : newParent).push(entry);
    } else {
      (binding.snapshot === 'data' ? dataNode : newNode).push(entry);
    }
  }
  if (!dataNode.length && !newNode.length && !dataParent.length && !newParent.length) return undefined;

  const expr = predicates.length === 1 ? predicates[0]! : predicates.map((p) => `(${p})`).join(' && ');
  const keepKey = expr.includes('__pyric_keep') ? undefined : '__pyric_keep';
  const usesParent = dataParent.length > 0 || newParent.length > 0;
  // Enforce via `.write` (not `.validate`), because RTDB skips `.validate` on deletes (null).
  let rules: ReturnType<typeof rtdbRules>;
  try {
    rules = usesParent
      ? rtdbRules({ rules: { root: { item: { '.write': expr } } } })
      : rtdbRules({ rules: { item: { '.write': expr } } });
  } catch {
    return undefined;
  }

  return (transition: Transition) => {
    try {
      const bBuilt = buildRtdbSlotValue(dataNode, transition, keepKey);
      const aBuilt = buildRtdbSlotValue(newNode, transition, keepKey);
      if (!bBuilt.ok || !aBuilt.ok) return undefined;
      if (!usesParent) {
        const [row] = rules.simulate([
          {
            path: '/item',
            operation: 'write',
            expectation: 'ALLOW',
            data: bBuilt.present ? { item: bBuilt.value } : {},
            newData: aBuilt.present ? aBuilt.value : null,
          },
        ]).cases;
        if (!row || row.unsupported) return undefined;
        return row.decision === 'ALLOW' || row.decision === 'DENY' ? row.decision : undefined;
      }
      const rootObj: Record<string, unknown> = {};
      if (bBuilt.present) rootObj.item = bBuilt.value;
      for (const item of dataParent) {
        const r = readTransitionPath(transition, item.policyPath);
        if (!r.present) continue;
        if (hasUnrepresentableRtdbValue(r.value, false)) return undefined;
        if (!setNestedPath(rootObj, item.binding.path!.split('/'), r.value)) return undefined;
      }
      for (const item of newParent) {
        const r = readTransitionPath(transition, item.policyPath);
        const segs = item.binding.path!.split('/');
        const existing = readNested(rootObj, segs);
        if (r.present) {
          if (hasUnrepresentableRtdbValue(r.value, false)) return undefined;
          if (!existing.present) {
            if (!setNestedPath(rootObj, segs, r.value)) return undefined;
          } else if (!deepEqualJson(existing.value, r.value)) return undefined;
        } else if (existing.present) {
          return undefined;
        }
      }
      const [row] = rules.simulate([
        {
          path: '/root/item',
          operation: 'write',
          expectation: 'ALLOW',
          data: Object.keys(rootObj).length ? { root: rootObj } : {},
          newData: aBuilt.present ? aBuilt.value : null,
        },
      ]).cases;
      if (!row || row.unsupported) return undefined;
      return row.decision === 'ALLOW' || row.decision === 'DENY' ? row.decision : undefined;
    } catch {
      return undefined;
    }
  };
}

/** Infer the natural Storage verb (`create` | `update` | `delete`) from bindings. */
export function inferStorageMethod(bindings: StorageBindings): StorageSimMethod {
  const targets = Object.values(bindings);
  const hasStored = targets.some((t) => t === 'resource' || t.startsWith('resource.'));
  const hasIncoming = targets.some((t) => t === 'request.resource' || t.startsWith('request.resource.'));
  if (hasStored && hasIncoming) return 'update';
  if (hasStored && !hasIncoming) return 'delete';
  return 'create';
}

function isWildcardIdent(target: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(target) &&
    target !== 'resource' &&
    target !== 'request' &&
    target !== 'firestore' &&
    target !== 'true' &&
    target !== 'false' &&
    target !== 'null'
  );
}

/** Pre-compile lowered Firebase Storage Rules v2 predicates for fast scenario + fuzz replay. */
export function createStorageEvaluator(
  predicates: readonly string[],
  bindings: StorageBindings,
  explicitMethod?: StorageSimMethod,
): ((transition: Transition) => TargetDecision | undefined) | undefined {
  if (!predicates.length) return undefined;
  const entries = Object.entries(bindings);
  if (entries.some(([, target]) => !SUPPORTED_STORAGE_BINDING.test(target))) return undefined;

  const method = explicitMethod ?? inferStorageMethod(bindings);
  const hasStored = entries.some(([, t]) => t === 'resource' || t.startsWith('resource.'));
  const hasIncoming = entries.some(([, t]) => t === 'request.resource' || t.startsWith('request.resource.'));
  if (method === 'create' && hasStored) return undefined;
  if (method === 'delete' && hasIncoming) return undefined;

  const wildcards = [...new Set(entries.map(([, t]) => t).filter(isWildcardIdent))];
  const matchPath = wildcards.length
    ? '/items/' + wildcards.map((w) => `{${w}}`).join('/') + '/{id}'
    : '/items/{id}';
  const expr = predicates.length === 1 ? predicates[0]! : predicates.map((p) => `(${p})`).join(' && ');

  let rules: ReturnType<typeof storageRules>;
  try {
    rules = storageRules(
      [
        "rules_version = '2';",
        'service firebase.storage {',
        '  match /b/{bucket}/o {',
        `    match ${matchPath} {`,
        `      allow ${method}: if ${expr};`,
        '    }',
        '  }',
        '}',
      ].join('\n'),
      { bucket: STORAGE_PROOF_BUCKET },
    );
  } catch {
    return undefined;
  }

  const hasAuth = entries.some(([, t]) => t === 'request.auth' || t.startsWith('request.auth.'));
  return (transition: Transition) => {
    try {
      let stored: Record<string, unknown> | undefined;
      let incoming: Record<string, unknown> | undefined;
      const wildcardVals = new Map<string, string>();
      for (const [policyPath, target] of entries) {
        if (target === 'true' || target === 'false') {
          const r = readTransitionPath(transition, policyPath);
          if (!r.present || r.value !== (target === 'true')) return undefined;
        } else if (target === 'request.method') {
          const r = readTransitionPath(transition, policyPath);
          if (!r.present || r.value !== method) return undefined;
        } else if (target === 'resource') {
          const r = readTransitionPath(transition, policyPath);
          if (!r.present || !isPlainRecord(r.value) || hasNonJsonNumber(r.value)) return undefined;
          stored = { ...r.value };
        } else if (target.startsWith('resource.')) {
          const r = readTransitionPath(transition, policyPath);
          if (r.present) {
            if (hasNonJsonNumber(r.value)) return undefined;
            stored ??= {};
            if (!setNestedPath(stored, target.slice('resource.'.length).split('.'), r.value)) return undefined;
          }
        } else if (target === 'request.resource') {
          const r = readTransitionPath(transition, policyPath);
          if (!r.present || !isPlainRecord(r.value) || hasNonJsonNumber(r.value)) return undefined;
          incoming = { ...r.value };
        } else if (target.startsWith('request.resource.')) {
          const r = readTransitionPath(transition, policyPath);
          if (r.present) {
            if (hasNonJsonNumber(r.value)) return undefined;
            incoming ??= {};
            if (!setNestedPath(incoming, target.slice('request.resource.'.length).split('.'), r.value)) return undefined;
          }
        } else if (isWildcardIdent(target)) {
          const r = readTransitionPath(transition, policyPath);
          if (!r.present || typeof r.value !== 'string' || !r.value.length || r.value.includes('/')) {
            return undefined;
          }
          const prev = wildcardVals.get(target);
          if (prev !== undefined && prev !== r.value) return undefined;
          wildcardVals.set(target, r.value);
        }
      }
      let auth: { uid: string; token?: Record<string, unknown> } | null | undefined;
      if (hasAuth) {
        const built = buildAuthFromEntries(entries, transition, false);
        if (!built.ok || (built.auth?.token && hasNonJsonNumber(built.auth.token))) return undefined;
        auth = built.auth;
      }
      const validSize = (obj: Record<string, unknown>): obj is Record<string, unknown> & { size: number } =>
        typeof obj.size === 'number' && Number.isSafeInteger(obj.size) && !Object.is(obj.size, -0) && obj.size >= 0;
      if (stored !== undefined && method !== 'create' && !validSize(stored)) return undefined;
      if (incoming !== undefined && method !== 'delete' && !validSize(incoming)) return undefined;
      const path = wildcards.length
        ? 'items/' + wildcards.map((w) => wildcardVals.get(w)!).join('/') + '/obj1'
        : 'items/obj1';
      const [row] = rules.simulate([
        {
          description: 'provePolicy-storage',
          method,
          path,
          expectation: 'ALLOW',
          ...(hasAuth ? { auth } : {}),
          ...(stored !== undefined && method !== 'create' ? { resource: stored as unknown as StorageCase['resource'] } : {}),
          ...(incoming !== undefined && method !== 'delete' ? { requestResource: incoming as unknown as StorageCase['requestResource'] } : {}),
        },
      ]).cases;
      if (!row || row.unsupported) return undefined;
      return row.decision === 'ALLOW' || row.decision === 'DENY' ? row.decision : undefined;
    } catch {
      return undefined;
    }
  };
}

const SAMPLE_MIMES = ['audio/wav', 'audio/ogg', 'audio/mpeg', 'image/png', 'image/jpeg', 'text/plain', 'image/svg+xml'];
const SAMPLE_SIZES = [0, 128, 512, 1024, 4096, 1048576, 2097152];
const SAMPLE_UIDS = ['alice', 'bob', 'u1'];

/** Generate a deterministic Storage-domain transition so `provePolicy` exercises real Storage simulation. */
export function generateStorageTransitionCase(
  checked: CheckedPolicyIR, bindings: StorageBindings, next: () => number, randomFallback: (next: () => number) => unknown,
): Transition {
  const roots: Record<'before' | 'after' | 'input', Record<string, unknown>> = { before: {}, after: {}, input: {} };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const makeResource = () => ({
    size: pick(SAMPLE_SIZES), contentType: pick(SAMPLE_MIMES), name: pick(['clip.wav', 'avatar.png', 'note.txt']),
    metadata: next() < 0.8 ? { owner: pick(SAMPLE_UIDS), tag: pick(['ok', 'vip']) } : {},
  });
  const handled = new Set<string>();
  for (const [policyPath, target] of Object.entries(bindings)) {
    const [root, ...rest] = policyPath.split('.');
    if (root !== 'before' && root !== 'after' && root !== 'input') continue;
    handled.add(policyPath);
    const assign = (val: unknown) => {
      if (!rest.length && isPlainRecord(val)) Object.assign(roots[root], val);
      else if (rest.length) setNestedPath(roots[root], rest, val);
    };
    if (target === 'resource' || target === 'request.resource') assign(makeResource());
    else if (target === 'resource.size' || target === 'request.resource.size') assign(pick(SAMPLE_SIZES));
    else if (target === 'resource.contentType' || target === 'request.resource.contentType') assign(pick(SAMPLE_MIMES));
    else if (target.endsWith('.metadata') || target.includes('.metadata.')) {
      assign(target.endsWith('.metadata') ? { owner: pick(SAMPLE_UIDS) } : pick(SAMPLE_UIDS));
    } else if (target === 'request.auth') assign(next() < 0.25 ? null : { uid: pick(SAMPLE_UIDS) });
    else if (target === 'true' || target === 'false') assign(target === 'true');
    else assign(pick(SAMPLE_UIDS));
  }
  for (const reads of checked.reads.values()) {
    for (const p of reads) {
      if (handled.has(p)) continue;
      const [root, ...rest] = p.split('.');
      if ((root !== 'before' && root !== 'after' && root !== 'input') || !rest.length) continue;
      if (!readNested(roots[root], rest).present) setNestedPath(roots[root], rest, randomFallback(next));
    }
  }
  return roots;
}
