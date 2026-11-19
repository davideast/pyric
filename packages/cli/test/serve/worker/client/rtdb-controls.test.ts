/** RTDB worker-client environment controls and server values. */
import { describe, expect, it } from 'bun:test';
import type { ClientPort } from '../../../../src/serve/worker/client/handles.js';
import * as client from '../../../../src/serve/worker/index.js';

function fakePort(): ClientPort {
  return {
    onmessage: null,
    postMessage() {},
    start() {},
    close() {},
  };
}

describe('RTDB worker controls', () => {
  it('constructs the timestamp sentinel used by worker writes', () => {
    expect(client.rtdbServerTimestamp()).toEqual({ '.sv': 'timestamp' });
  });

  it('rebinds a worker database handle to an HTTP emulator origin before start', () => {
    const db = client.rtdbGetDatabase({ __kind: 'client-db', port: fakePort() });
    expect(client.rtdbConnectDatabaseEmulator(db, '127.0.0.1', 9000)).toBeUndefined();
    expect(client.rtdbRef(db, 'items/k1').toString()).toBe('http://127.0.0.1:9000/items/k1');
  });
});
