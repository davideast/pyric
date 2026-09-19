import { MAX_PENDING_OPERATIONS, MAX_QUEUED_OPERATION_BYTES } from './protocol.js';

const utf8 = new TextEncoder();

type OperationReservation =
  | { accepted: true; release(): void }
  | { accepted: false; error: { code: string; message: string } };

/** Own one client's accepted operation charges until each caller releases its reservation. */
export function createOperationBudget(): { reserve(message: unknown): OperationReservation } {
  let pendingOperations = 0;
  let pendingOperationBytes = 0;

  return {
    reserve(message) {
      const hasReachedCapacity = pendingOperations >= MAX_PENDING_OPERATIONS;
      if (hasReachedCapacity) {
        return { accepted: false, error: { code: 'resource-exhausted', message: 'This client already has 256 pending operations.' } };
      }
      let operationBytes: number;
      try {
        operationBytes = utf8.encode(JSON.stringify(message)).byteLength;
      } catch {
        return { accepted: false, error: { code: 'invalid-argument', message: 'The operation must have a JSON-serializable encoding.' } };
      }
      const exceedsByteLimit = pendingOperationBytes + operationBytes > MAX_QUEUED_OPERATION_BYTES;
      if (exceedsByteLimit) {
        return { accepted: false, error: { code: 'resource-exhausted', message: 'This client exceeds the 24 MiB queued operation byte limit.' } };
      }
      pendingOperations += 1;
      pendingOperationBytes += operationBytes;
      return {
        accepted: true,
        release() {
          pendingOperations -= 1;
          pendingOperationBytes -= operationBytes;
        },
      };
    },
  };
}
