import { describe, expect, it } from 'bun:test';
import { GrpcStatus, setLogFunction } from '../../src/firestore/index.js';
import { emitAdminFirestoreLog } from '../../src/firestore/admin-grpc-log.js';

describe('pyric-admin/firestore GrpcStatus and setLogFunction', () => {
  it('exposes bidirectional GrpcStatus codes 0..16', () => {
    expect(GrpcStatus.OK).toBe(0);
    expect(GrpcStatus.INVALID_ARGUMENT).toBe(3);
    expect(GrpcStatus.NOT_FOUND).toBe(5);
    expect(GrpcStatus.ALREADY_EXISTS).toBe(6);
    expect(GrpcStatus.PERMISSION_DENIED).toBe(7);
    expect(GrpcStatus.FAILED_PRECONDITION).toBe(9);
    expect(GrpcStatus.UNAUTHENTICATED).toBe(16);
    expect(GrpcStatus['5']).toBe('NOT_FOUND');
  });

  it('registers and clears log callbacks via setLogFunction', () => {
    const messages: string[] = [];
    setLogFunction((msg) => messages.push(msg));
    emitAdminFirestoreLog('hello');
    setLogFunction(null);
    emitAdminFirestoreLog('ignored');
    expect(messages).toEqual(['hello']);
  });
});
