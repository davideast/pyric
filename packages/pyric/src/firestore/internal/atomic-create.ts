import type { DocumentReference, Transaction, WriteBatch } from '../types.js';

type CreateCapableWriter = WriteBatch | Transaction;
type CreateHook = (ref: DocumentReference<unknown>, data: unknown) => void;

const CREATE_HOOKS = new WeakMap<CreateCapableWriter, CreateHook>();

export function registerAtomicWriterCreate(writer: CreateCapableWriter, onCreate: CreateHook): void {
  CREATE_HOOKS.set(writer, onCreate);
}

/**
 * Queue a create-if-absent write onto a modular `WriteBatch` or `Transaction`
 * without exposing Admin-only `.create()` on the Web SDK public surface.
 */
export function atomicWriterCreate(
  writer: CreateCapableWriter,
  ref: DocumentReference<unknown>,
  data: unknown,
): void {
  const hook = CREATE_HOOKS.get(writer);
  if (!hook) {
    throw new Error('Unrecognized Firestore atomic writer handle.');
  }
  hook(ref, data);
}
