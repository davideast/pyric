/**
 * Worker-client handle types — the opaque, port-carrying references the client
 * surface hands back to callers. Shared by every API family (firestore, auth,
 * rtdb, storage), so they live in one leaf module with no runtime dependencies
 * beyond the wire-protocol descriptor types.
 */
import type {
  DocRef,
  CollRef,
  QueryDescriptor,
  InboundMessage,
  OutboundMessage,
} from '../protocol.js';

/** The exact transport contract shared by native MessagePort and SW relay ports. */
export interface ClientPort {
  onmessage: ((event: MessageEvent<OutboundMessage>) => void) | null;
  postMessage(message: InboundMessage): void;
  start(): void;
  close(): void;
}

/** Opaque client-side Firestore handle. Holds the MessagePort to the worker. */
export interface ClientDb {
  readonly __kind: 'client-db';
  readonly port: ClientPort;
}

export interface ClientRtdb {
  readonly __kind: 'client-rtdb';
  readonly port: ClientPort;
}

export interface RtdbRefHandle {
  readonly __kind: 'rtdb-ref';
  readonly port: ClientPort;
  readonly path: string;
  readonly key: string | null;
  readonly parent: RtdbRefHandle | null;
  readonly root: RtdbRefHandle;
  toString(): string;
}

export interface RtdbDataSnapshot {
  readonly key: string | null;
  readonly size: number;
  exists(): boolean;
  val(): unknown;
  child(path: string): RtdbDataSnapshot;
  hasChild(path: string): boolean;
  hasChildren(): boolean;
  exportVal(): unknown;
  toJSON(): unknown;
  forEach(cb: (child: RtdbDataSnapshot) => boolean | void): boolean;
  readonly ref: RtdbRefHandle;
}

/** Client-side document reference — carries a DocRef descriptor + port. */
export interface DocRefHandle {
  readonly __kind: 'doc-ref';
  readonly descriptor: DocRef;
  readonly port: ClientPort;
  readonly id: string;
  readonly path: string;
}

/** Client-side collection reference. */
export interface CollRefHandle {
  readonly __kind: 'coll-ref';
  readonly descriptor: CollRef;
  readonly port: ClientPort;
  readonly id: string;
  readonly path: string;
}

/** Client-side query. */
export interface QueryHandle {
  readonly __kind: 'query';
  readonly descriptor: QueryDescriptor;
  readonly port: ClientPort;
}

/** Union of all client handles. */
export type AnyHandle = ClientDb | DocRefHandle | CollRefHandle | QueryHandle;

/** Unsubscribe function returned by every streaming subscription. */
export type Unsubscribe = () => void;

export function lastSegment(path: string): string {
  return path.split('/').at(-1) ?? path;
}
