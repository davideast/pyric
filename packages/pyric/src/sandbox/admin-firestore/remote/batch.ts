/** `WriteBatch` for the remote arm — buffers writes client-side and
 *  ships them as one `batchCommit` op. */

import { SandboxError } from 'pyric/sandbox';
import type { DocumentData, DocumentReference, OperationOptions, WriteBatch } from 'pyric/sandbox/admin-compat';
import { armOp, type RemoteArm } from './channel.js';
import { encodeWriteData } from './value-codec.js';
import type { WireWrite } from './wire-types.js';

export function makeWriteBatch(arm: RemoteArm): WriteBatch {
  const writes: WireWrite[] = [];
  let committed = false;
  const batch: WriteBatch = {
    set(ref: DocumentReference, data: DocumentData): WriteBatch {
      assertNotCommitted();
      writes.push({ method: 'set', path: ref.path, data: encodeWriteData(data) });
      return batch;
    },
    update(ref: DocumentReference, data: DocumentData): WriteBatch {
      assertNotCommitted();
      writes.push({ method: 'update', path: ref.path, data: encodeWriteData(data) });
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
