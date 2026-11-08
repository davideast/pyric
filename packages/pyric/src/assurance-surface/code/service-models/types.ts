/**
 * Declarative per-service SDK model contracts and query constraint IR shapes.
 * Adding a new service (such as Cloud Storage) requires registering a
 * `SdkServiceModel` table with zero evaluator or collector changes.
 */
import type { AssuranceService } from '../../../sandbox/internal/resource-pattern.js';
import type { AuthProvenance } from '../types.js';

export type { AssuranceService } from '../../../sandbox/internal/resource-pattern.js';

export type RefKind = 'doc' | 'collection' | 'collectionGroup' | 'node' | 'object';

export type FieldValueName =
  | 'serverTimestamp'
  | 'increment'
  | 'arrayUnion'
  | 'arrayRemove'
  | 'deleteField';

export interface HandleFactorySpec {
  readonly resourceArgIndex?: number;
  /** True when a 1-arg string call (`getFirestore('analytics-db')`, `getDatabase('https://...')`) sets `resourceId`. */
  readonly singleStringArgIsResource?: boolean;
}

export interface RefConstructorSpec {
  readonly refKind: RefKind;
  readonly mode?: 'segments' | 'collectionGroup' | 'url';
  /** Exclusive end index of path arguments when trailing arguments carry write data (`addDoc`, `push`). */
  readonly pathArgsEnd?: number;
  /** Variable hole appended unconditionally (`'autoId'` for `addDoc`, `'pushId'` for `push`). */
  readonly appendHole?: string;
  /** Variable hole appended when called with only the base ref (`doc(collectionRef)` -> `'autoId'`). */
  readonly singleArgAppendHole?: string;
  /** False when a standalone call only mints a key (`push(ref)`) and should not emit an unresolved site. */
  readonly reportUnconsumed?: boolean;
}

export interface ConstraintSpec {
  readonly kind: string;
  readonly fieldArg?: number;
  readonly opArg?: number;
  readonly directionArg?: number;
  readonly defaultDirection?: 'asc' | 'desc';
  readonly valueArg?: number;
  readonly composite?: boolean;
}

export interface OpSpec {
  readonly op: string;
  readonly write?: boolean;
  /** Index of the written value argument, if any. */
  readonly data?: number;
  /** Index of an options argument (`setDoc(ref, data, { merge })`). */
  readonly options?: number;
  /** True for reads whose operation name adapts to collection/query refs (`get` vs `query`). */
  readonly readKind?: boolean;
  readonly listen?: boolean;
  /** Segment hole appended to the ref (`addDoc`, `push`). */
  readonly append?: string;
  /** Minimum argument count for the call to be an operation rather than a ref constructor (`push(ref, val)`). */
  readonly minArgs?: number;
  readonly via?: 'batch' | 'transaction';
  /** Expected ref kind for document-only writes (`setDoc`, `updateDoc`, `deleteDoc`). */
  readonly expectedRefKind?: RefKind;
  /** True when key/value pairs may be passed variadically (`updateDoc(ref, 'a', 1, 'b', 2)`). */
  readonly variadicFieldPairs?: boolean;
  /** True when slash-containing object keys expand as multi-path updates (`update(ref, { 'a/b': 1 })`). */
  readonly multiPathUpdate?: boolean;
  /** True when the ref lives on the receiver handle (`onDisconnect(ref).set(...)`). */
  readonly usesReceiverRef?: boolean;
}

export interface ReceiverFactorySpec {
  readonly receiverKind: string;
  readonly refArgIndex?: number;
}

export interface SdkServiceModel {
  readonly service: AssuranceService;
  readonly modules: readonly string[];
  readonly handleFactories: Readonly<Record<string, HandleFactorySpec>>;
  readonly refConstructors: Readonly<Record<string, RefConstructorSpec>>;
  readonly queryBuilder?: string;
  readonly constraints: Readonly<Record<string, ConstraintSpec>>;
  readonly operations: Readonly<Record<string, OpSpec>>;
  readonly receiverMethods?: Readonly<Record<string, Readonly<Record<string, OpSpec>>>>;
  readonly receiverFactories?: Readonly<Record<string, ReceiverFactorySpec>>;
  readonly callbackReceivers?: Readonly<Record<string, Readonly<Record<number, string>>>>;
  readonly fieldValues?: Readonly<Record<string, FieldValueName>>;
  readonly specialStrings?: Readonly<Record<string, string>>;
  readonly nestedFieldSeparator?: '.' | '/';
  readonly defaultRefKind?: RefKind;
  readonly queryBaseRefKind?: RefKind;
}

export interface ConstraintOperand {
  readonly kind: 'literal' | 'auth' | 'array' | 'param' | 'unknown';
  readonly literal?: string | number | boolean | null;
  readonly items?: readonly ConstraintOperand[];
  readonly auth?: readonly AuthProvenance[];
}

export interface SdkQueryConstraint {
  readonly kind: string;
  readonly field?: string;
  readonly op?: string;
  readonly direction?: 'asc' | 'desc';
  /** Preserved from `where(field, op, value)` / `equalTo(value)` for static query analysis. */
  readonly operand?: ConstraintOperand;
  /** Nested children for composite `and(...)` / `or(...)` filters. */
  readonly children?: readonly SdkQueryConstraint[];
}
