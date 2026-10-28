/** `WriteBatch` for the remote arm — buffers writes client-side and
 *  ships them as one `batchCommit` op. */

import { SandboxError } from 'pyric/sandbox';
import type { DocumentData, DocumentReference, OperationOptions, SetOptions, WriteBatch } from 'pyric/sandbox/admin-compat';
import { armOp, type RemoteArm } from './channel.js';
import { encodeUpdateFields, encodeWriteData } from './value-codec.js';
import { parseAdminUpdateArguments } from '../../../firestore/sandbox/admin-compat/field-path.js';
import type { WireWrite } from './wire-types.js';

export type WireSetOptions = NonNullable<Extract<WireWrite, { method: 'set' }>['options']>;

export function toWireSetOptions(options?: SetOptions): WireSetOptions | undefined {
  if (options === undefined) return undefined;
  const wireOptions: WireSetOptions = {};
  if ('merge' in options && options.merge !== undefined) {
    wireOptions.merge = options.merge;
  }
  if ('mergeFields' in options && options.mergeFields !== undefined) {
    wireOptions.mergeFields = options.mergeFields.map((field) => String(field));
  }
  return wireOptions;
}

export function makeWriteBatch(arm: RemoteArm): WriteBatch {
  const writes: WireWrite[] = [];
  let committed = false;
  const batch: WriteBatch = {
    create(ref: DocumentReference, data: DocumentData): WriteBatch {
      assertNotCommitted();
      writes.push({ method: 'create', path: ref.path, data: encodeWriteData(data) });
      return batch;
    },
    set(ref: DocumentReference, data: DocumentData, options?: SetOptions): WriteBatch {
      assertNotCommitted();
      const write: WireWrite = { method: 'set', path: ref.path, data: encodeWriteData(data) };
      const wireOptions = toWireSetOptions(options);
      const hasWireOptions = wireOptions !== undefined;
      if (hasWireOptions) write.options = wireOptions;
      writes.push(write);
      return batch;
    },
    update(ref: DocumentReference, dataOrField: unknown, ...preconditionOrValues: unknown[]): WriteBatch {
      assertNotCommitted();
      const { fields } = parseAdminUpdateArguments(dataOrField, preconditionOrValues);
      writes.push({ method: 'update', path: ref.path, fields: encodeUpdateFields(fields) });
      return batch;
    },
    delete(ref: DocumentReference): WriteBatch {
      assertNotCommitted();
      writes.push({ method: 'delete', path: ref.path });
      return batch;
    },
    async commit(_opts?: OperationOptions): Promise<void> {
      assertNotCommitted();
      committed = true;
      await armOp(arm, { method: 'batchCommit', writes });
    },
  };
  function assertNotCommitted(): void {
    if (committed) {
      throw new SandboxError('failed-precondition', 'WriteBatch has already been committed.');
    }
  }
  return batch;
}
