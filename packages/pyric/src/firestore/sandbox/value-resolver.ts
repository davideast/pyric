/**
 * Write-boundary value resolver — central pass that runs over every value
 * tree about to enter {@link LocalState}.
 *
 * Why this exists:
 *   The simulator stores plain JS objects but agents seed/write values
 *   that need normalization before either rules or storage see them:
 *     - `Date` / `Timestamp` instances must round-trip with the right
 *       wire type (Item 1).
 *     - `serverTimestamp()`, `increment()`, `arrayUnion/Remove()`,
 *       `deleteField()` sentinels must be resolved against prior doc
 *       state (Item 2).
 *     - `DocumentReference`, `VectorValue` need wrapper conversion
 *       (Items 3, 5).
 *
 *   Doing each of these in five different write methods is a recipe for
 *   drift. Item 0 introduces a single chokepoint: every value about to
 *   land in storage passes through {@link resolveValueTree} first.
 *
 * Design — registry of converters:
 *   Items 1, 2, 3, 5 each register a {@link ValueConverter}. Converters
 *   inspect a value and either substitute it (returning the replacement)
 *   or decline (returning {@link KEEP}). The resolver tries converters in
 *   registration order; if none claim the value, plain objects and arrays
 *   are walked recursively. Class instances the resolver doesn't recognize
 *   pass through unchanged.
 *
 * Idempotency contract:
 *   Every converter MUST no-op on its own output. This lets multiple
 *   layers (LocalEnvironment.execute pre-rules, LocalState.write
 *   pre-storage) call the resolver without double-applying conversions.
 *   The Item 0 test contract verifies the empty-registry case is itself
 *   idempotent.
 *
 * Today (Item 0) the registry is empty — the resolver is an identity
 * walk. Wiring is in place so Items 1+ are pure additions.
 */

import { dateConverter, serverTimestampConverter } from './converters/timestamp.js';
import { userTimestampConverter } from './converters/user-timestamp.js';
import {
  incrementConverter,
  arrayUnionConverter,
  arrayRemoveConverter,
  deleteFieldConverter,
} from './converters/fieldvalue.js';
import { documentReferenceConverter } from './converters/reference.js';
import { vectorValueConverter } from './converters/vector.js';
import { bytesConverter, geoPointConverter } from './converters/bytes-geopoint.js';

export type DocumentData = Record<string, unknown>;

/** Operation that triggered the resolve. Converters can branch on this. */
export type ResolveMethod = 'seed' | 'create' | 'update' | 'set';

export interface ResolveContext {
  /** Doc path being written (e.g., `users/u1`). */
  path: string;
  /** Method that triggered the resolve. */
  method: ResolveMethod;
  /** Prior doc state at `path`, or `null` if the doc did not exist. */
  prior: DocumentData | null;
  /**
   * Dotted field path inside the doc; empty string for the root map.
   * Array indices are bracketed: `tags[0]`, `users.profile.name`.
   * Used by sentinel converters that need to read prior at the right
   * field (e.g., `increment` reads `prior.<fieldPath>`).
   */
  fieldPath: string;
  /**
   * Server time for this write, if the caller wants every
   * `serverTimestamp()` sentinel in the tree to resolve to the SAME
   * Timestamp instance. `LocalEnvironment.execute` plumbs this in (Item 1)
   * so `request.resource.data.createdAt == request.time` works
   * deterministically. Direct `LocalState.write` calls leave it
   * undefined; sentinel converters fall back to `Timestamp.fromMillis(
   * Date.now())` per call.
   *
   * Type is `unknown` here to keep the resolver core decoupled from
   * the wrappers package. Converters cast as needed.
   */
  serverTime?: unknown;
}

/**
 * Sentinel returned by converters that decline to claim a value. Using a
 * Symbol rather than `undefined` lets converters legitimately substitute
 * `undefined` if they ever need to (e.g., `deleteField()` resolution).
 */
export const KEEP: unique symbol = Symbol('value-resolver:KEEP');
export type Keep = typeof KEEP;

/**
 * Sentinel substituted by the deleteField converter (Item 2). The
 * resolver returns this in place of `{ __type: 'deleteField' }`; the
 * write layer ({@link partitionDeletes}) then strips these markers
 * out of the value tree and surfaces the affected top-level keys to
 * `LocalState` so the existing field is removed from storage.
 *
 * Why a symbol rather than another `__type` object: it cannot
 * accidentally collide with user data, it survives a structuredClone-
 * free copy intact (the resolver doesn't clone its outputs), and it
 * makes idempotency trivial — the converter only matches the sentinel
 * shape, never the marker.
 */
export const DELETE_MARKER: unique symbol = Symbol('value-resolver:DELETE_MARKER');
export type DeleteMarker = typeof DELETE_MARKER;

export interface ValueConverter {
  /** Name surfaced in diagnostics; must be unique across registrations. */
  name: string;
  /**
   * Inspect a value. Return any value to substitute it (the resolver
   * does NOT descend into the substituted value — converters own their
   * output). Return {@link KEEP} to decline; the resolver tries the next
   * converter, then descends into containers.
   */
  convert(value: unknown, ctx: ResolveContext): unknown | Keep;
}

const converters: ValueConverter[] = [];

/**
 * Register a converter. Idempotent on `name` — re-registering the same
 * named converter is a no-op. Item modules register their converters via
 * {@link registerDefaultConverters} on simulator startup.
 */
export function registerConverter(c: ValueConverter): void {
  if (converters.some((existing) => existing.name === c.name)) return;
  converters.push(c);
}

/** For tests only — clears the registry. Production code never calls this. */
export function _clearConvertersForTest(): void {
  converters.length = 0;
}

/** Snapshot of registered converter names. Diagnostics + test introspection. */
export function listConverters(): string[] {
  return converters.map((c) => c.name);
}

/**
 * Resolve a full document tree. Walks each top-level field with the
 * resolver, returning a new object — never mutates input.
 */
export function resolveValueTree(
  data: DocumentData,
  ctx: Omit<ResolveContext, 'fieldPath'>,
): DocumentData {
  const out: DocumentData = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = resolveValue(value, { ...ctx, fieldPath: key });
  }
  return out;
}

/**
 * Resolve a single value. Exported for converter unit tests; production
 * code should call {@link resolveValueTree}.
 */
export function resolveValue(value: unknown, ctx: ResolveContext): unknown {
  // First pass: offer the value to every converter in registration order.
  for (const c of converters) {
    const replaced = c.convert(value, ctx);
    if (replaced !== KEEP) return replaced;
  }

  // No converter claimed it. Descend into containers; pass through everything else.
  if (Array.isArray(value)) {
    return value.map((v, i) =>
      resolveValue(v, { ...ctx, fieldPath: `${ctx.fieldPath}[${i}]` }),
    );
  }
  if (isPlainObject(value)) {
    const inner: DocumentData = {};
    for (const [k, v] of Object.entries(value)) {
      const childPath = ctx.fieldPath ? `${ctx.fieldPath}.${k}` : k;
      inner[k] = resolveValue(v, { ...ctx, fieldPath: childPath });
    }
    return inner;
  }
  // Primitives, Dates, class instances, functions, etc. — identity.
  return value;
}

/**
 * Plain-object detection: an object literal whose prototype chain is
 * `Object.prototype` (or null, for `Object.create(null)`). Class
 * instances like `Date`, `Timestamp`, `DocumentReference` deliberately
 * fall through to converter-or-identity handling — the resolver should
 * not silently strip their prototype by walking them as plain maps.
 */
export function isPlainObject(value: unknown): value is DocumentData {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Item 2 — split a resolved tree into "values to write" and "fields to
 * delete" by walking it for {@link DELETE_MARKER} sentinels.
 *
 * For top-level keys whose value is `DELETE_MARKER`, the key is removed
 * from `writes` and added to `deletedKeys`. For nested occurrences, the
 * marker is stripped from its containing object so it never lands in
 * storage. Arrays are not a Firestore-idiomatic place for deleteField,
 * but for safety any nested marker inside an array is dropped (the
 * array is rebuilt without the deleted element to avoid leaving a
 * symbol in the wire payload).
 *
 * Idempotency: a tree that has already been partitioned contains no
 * markers, so this is a no-op on its own output. Both
 * `LocalEnvironment.execute` (for rule visibility) and `LocalState.write`
 * call this; the second call sees nothing to do.
 *
 * Note: this top-level partition backs the `create` / non-merge `set`
 * paths. The `update` path is handled by `field-merge.applyUpdate`, which
 * supports dot-path deletes (`{'a.b': deleteField()}` removes the nested
 * leaf — FS-B5) and rejects a `deleteField()` nested inside a map literal
 * with `invalid-argument` (FS-B13), rather than silently destroying the
 * sibling map. `partitionDeletes` itself only sees top-level markers and
 * strips any nested ones it encounters.
 */
export function partitionDeletes(
  data: DocumentData,
): { writes: DocumentData; deletedKeys: string[] } {
  const writes: DocumentData = {};
  const deletedKeys: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === DELETE_MARKER) {
      deletedKeys.push(key);
      continue;
    }
    writes[key] = stripMarkers(value);
  }
  return { writes, deletedKeys };
}

export function stripMarkers(value: unknown): unknown {
  if (value === DELETE_MARKER) return undefined;
  if (Array.isArray(value)) {
    return value.filter((v) => v !== DELETE_MARKER).map(stripMarkers);
  }
  if (isPlainObject(value)) {
    const out: DocumentData = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === DELETE_MARKER) continue;
      out[k] = stripMarkers(v);
    }
    return out;
  }
  return value;
}

/**
 * Register every converter the simulator ships with. Called by
 * {@link LocalEnvironment} on construction; safe to call multiple times
 * (each `registerConverter` is idempotent on name). Items 1+ extend this
 * function as their converters land.
 *
 * Converter ordering note: order matters for first-wins claiming. Items
 * 2-5 must register their sentinel/wrapper converters BEFORE the generic
 * plain-object descent kicks in — but converters never compete with each
 * other in practice (they each detect a distinct shape).
 */
export function registerDefaultConverters(): void {
  // Item 1: Date → Timestamp + serverTimestamp sentinel resolution.
  registerConverter(dateConverter);
  registerConverter(serverTimestampConverter);
  // FS-B4: a user-written compat / firebase Timestamp → rules-internal
  // Timestamp, so it passes `is timestamp` and shares storage shape with
  // serverTimestamp()/Date-resolved timestamps (unified comparability).
  registerConverter(userTimestampConverter);
  // Item 2: FieldValue sentinels (increment, arrayUnion/Remove, deleteField).
  registerConverter(incrementConverter);
  registerConverter(arrayUnionConverter);
  registerConverter(arrayRemoveConverter);
  registerConverter(deleteFieldConverter);
  // Item 3: admin SDK DocumentReference → Reference wrapper.
  registerConverter(documentReferenceConverter);
  // Item 5: admin SDK VectorValue → Vector wrapper.
  registerConverter(vectorValueConverter);
  // Item 6: firebase/firestore Bytes + GeoPoint → rules-wrapper Bytes/LatLng.
  // Lets `Bytes` / `GeoPoint` written via the modular SDK round-trip
  // through the sandbox as proper instances (closes #109 + #110).
  registerConverter(bytesConverter);
  registerConverter(geoPointConverter);
}
