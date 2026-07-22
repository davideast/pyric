/**
 * `DocumentRefImpl` — Admin-SDK-compat `DocumentReference` backed by
 * `LocalEnvironment`.
 *
 * Ported from bench's `pilot/src/firestore-wrapper.ts:213-270`. The
 * behavioral nuance worth a comment is `set()`: the simulator's
 * evaluator wants distinct `'create'` / `'update'` rule clauses (no
 * `allow set:` syntax). So `set()` peeks at `getDocument(path)`,
 * dispatches to `create` if absent / `update` if present.
 *
 * Differences from the bench source:
 *   - Plain `Error` throws → `FirestoreCompatError` with the typed
 *     `FirestoreErrorCode` from the SDK's `OperationResult.error`.
 *     Falls back to `'permission-denied'` if the simulator returned a
 *     denial without a structured error (defense-in-depth — slice-1
 *     review locked that every denial carries `error`, but the
 *     fallback keeps the wrapper honest if that invariant ever slips).
 *   - The `update`-as-partial vs Firestore-`set`-as-replace divergence
 *     is documented (and locked) at the design-doc level — see
 *     the design rationale.
 */

import type { LocalEnvironment } from 'pyric/sandbox/internal';
import { makeError } from 'pyric/sandbox/internal';
import type { OperationResult } from 'pyric/sandbox/internal';
import { lastSegment, parentCollectionPath } from './paths.js';
import { makeDocSnapshot } from './snapshots.js';
import {
  boundedActivityIdentity,
  registerActivityValue,
} from '../../../firestore/sandbox/activity-value-registry.js';
import { registerReferenceQueryValue } from '../../../firestore/sandbox/query-value-registry.js';
import {
  FirestoreCompatError,
  type AuthContext,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type OperationOptions,
  type SetOptions,
} from './types.js';

/**
 * Convert a denied `OperationResult` into a typed throwable. Prefers
 * the result's structured error; falls back to `'permission-denied'`
 * with a stitched-together message from `debugMessages`.
 */
function throwFromDenial(
  result: OperationResult,
  contextLabel: string,
): never {
  if (result.error) {
    throw new FirestoreCompatError(result.error);
  }
  const msg = result.debugMessages.length > 0
    ? result.debugMessages.join('; ')
    : '(no debug message)';
  throw new FirestoreCompatError(
    makeError('permission-denied', `${contextLabel}: ${msg}`),
  );
}

export class DocumentRefImpl implements DocumentReference {
  readonly id: string;
  readonly path: string;

  constructor(
    private readonly env: LocalEnvironment,
    private readonly auth: AuthContext,
    path: string,
    // Studio admin lens (Gap #2) — stamped onto every Operation this ref
    // issues. Inherited by child collection refs. Default false.
    private readonly bypassRules: boolean = false,
    private readonly collectionRef: (path: string) => CollectionReference,
  ) {
    this.path = path;
    this.id = lastSegment(path);
    registerActivityValue(this, boundedActivityIdentity('reference', path));
    registerReferenceQueryValue(this, path, env);
  }

  get parent(): CollectionReference {
    return this.collectionRef(parentCollectionPath(this.path));
  }

  collection(name: string): CollectionReference {
    return this.collectionRef(`${this.path}/${name}`);
  }

  async get(opts?: OperationOptions): Promise<DocumentSnapshot> {
    const result = this.env.execute({
      method: 'get',
      path: this.path,
      auth: opts?.auth !== undefined ? opts.auth : this.auth,
      bypassRules: this.bypassRules,
    });
    if (!result.allowed) throwFromDenial(result, 'get denied');
    // execute() returns `data: undefined` for "denied" and `data: null`
    // for "doc absent (rule allowed)". makeDocSnapshot treats both as
    // "not exists", which matches Admin SDK's `snap.exists === false`
    // for a get of a missing doc.
    const data = result.data === undefined || result.data === null
      ? undefined
      : result.data;
    return makeDocSnapshot(this, data);
  }

  async set(data: DocumentData, options?: SetOptions): Promise<void> {
    // Three branches — each rides on the same execute() pipeline but
    // chooses a different combination of (rule clause, storage mode):
    //
    //   - default: rule clause picked by execute() (create / update),
    //     storage REPLACES via the `'set'` method. Matches Firestore
    //     `set(data)` semantics.
    //   - { merge: true }: shallow-merge every top-level field via the
    //     `'update'` rule clause + storage update (which merges).
    //     Falls back to `'create'` when the doc is absent.
    //   - { mergeFields: [...] }: project `data` to just the listed
    //     top-level fields, then dispatch the same way as merge:true.
    const auth = options?.auth !== undefined ? options.auth : this.auth;

    if (options?.mergeFields !== undefined) {
      // FS-B6: pass the full data + the field-path mask to the merge
      // engine. It deep-merges only the listed (dot-separated) paths into
      // the existing doc — dropping the old shallow top-level projection.
      const mergeFields = options.mergeFields.map((f) => String(f));
      const existing = this.env.getDocument(this.path);
      const method = existing === null ? 'create' : 'update';
      const result = this.env.execute({
        method, path: this.path, data, auth, merge: { mergeFields },
        bypassRules: this.bypassRules,
      });
      if (!result.allowed) throwFromDenial(result, `set denied (as ${method})`);
      return;
    }

    if (options?.merge === true) {
      // FS-B6: deep-merge nested maps into the existing doc instead of the
      // old shallow top-level spread.
      const existing = this.env.getDocument(this.path);
      const method = existing === null ? 'create' : 'update';
      const result = this.env.execute({
        method, path: this.path, data, auth, merge: true,
        bypassRules: this.bypassRules,
      });
      if (!result.allowed) throwFromDenial(result, `set denied (as ${method})`);
      return;
    }

    // Default — replace semantics. The simulator's `'set'` method
    // translates to `create` / `update` for rules eval but routes to
    // `state.set` (replace) for storage.
    const result = this.env.execute({
      method: 'set', path: this.path, data, auth,
      bypassRules: this.bypassRules,
    });
    if (!result.allowed) throwFromDenial(result, 'set denied');
  }

  async update(data: DocumentData, opts?: OperationOptions): Promise<void> {
    const result = this.env.execute({
      method: 'update',
      path: this.path,
      data,
      auth: opts?.auth !== undefined ? opts.auth : this.auth,
      bypassRules: this.bypassRules,
    });
    if (!result.allowed) throwFromDenial(result, 'update denied');
  }

  async delete(opts?: OperationOptions): Promise<void> {
    const result = this.env.execute({
      method: 'delete',
      path: this.path,
      auth: opts?.auth !== undefined ? opts.auth : this.auth,
      bypassRules: this.bypassRules,
    });
    if (!result.allowed) throwFromDenial(result, 'delete denied');
  }
}
