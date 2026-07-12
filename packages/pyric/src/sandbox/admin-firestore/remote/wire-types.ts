/**
 * Loose wire shapes — structural mirrors of the `@pyric/cli` worker
 * protocol. Spelled loosely (not imported from the protocol module)
 * because `pyric` cannot depend on `@pyric/cli`; ops are kept
 * structurally identical to `packages/pyric-tools/src/serve/worker/protocol.ts`.
 */

/** Wire form of a doc/collection/group/query target. Mirrors
 *  `@pyric/cli`' `TargetDescriptor` — plain JSON, spelled loosely here
 *  because `pyric` cannot import the protocol module. */
export type WireTarget =
  | { __ref: 'doc'; path: string }
  | { __ref: 'collection'; path: string }
  | { __ref: 'group'; collectionId: string }
  | {
      __ref: 'query';
      source: { __ref: 'doc'; path: string } | { __ref: 'collection'; path: string } | { __ref: 'group'; collectionId: string };
      constraints: WireConstraint[];
    };

export type WireFilter =
  | { kind: 'where'; field: string; op: string; value: unknown }
  | { kind: 'and'; filters: WireFilter[] }
  | { kind: 'or'; filters: WireFilter[] };

export type WireConstraint =
  | WireFilter
  | { kind: 'orderBy'; field: string; direction?: 'asc' | 'desc' }
  | { kind: 'limit'; n: number }
  | { kind: 'limitToLast'; n: number }
  | { kind: 'startAt'; values: unknown[] }
  | { kind: 'startAfter'; values: unknown[] }
  | { kind: 'endAt'; values: unknown[] }
  | { kind: 'endBefore'; values: unknown[] };

/** Mirrors the protocol's `WriteDescriptor`. */
export type WireWrite =
  | { method: 'set'; path: string; data: unknown; options?: { merge?: boolean; mergeFields?: string[] } }
  | { method: 'update'; path: string; data: unknown }
  | { method: 'delete'; path: string };

/** Mirrors the protocol's `SerializedDocData` — the JSON string envelope. */
export interface WireDocData {
  json: string;
}

/** Mirrors the protocol's `TxnReadEntry`. `data` is the worker's ORIGINAL
 *  serialized envelope (or null for a missing doc) — never re-serialized. */
export interface WireTxnRead {
  path: string;
  data: WireDocData | null;
}

/** `getDoc` result / doc-listener snap value on the wire. */
export interface WireDocSnap {
  id: string;
  path?: string;
  exists: boolean;
  data?: WireDocData;
}

/** `getDocs` result / query-listener snap value on the wire. */
export interface WireQuerySnap {
  docs: Array<{ id: string; path?: string; exists?: boolean; data?: WireDocData }>;
}
