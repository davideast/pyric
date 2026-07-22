/** RTDB worker-client environment controls and server values. */
import { describe, expect, it } from 'bun:test';
import * as client from '../../../src/serve/worker/index.js';

describe('RTDB worker controls', () => {
  it('constructs the timestamp sentinel used by worker writes', () => {
    expect(client.rtdbServerTimestamp()).toEqual({ __rtdbSentinel: 'serverTimestamp' });
  });

  it('accepts the emulator control as a sandbox-local no-op', () => {
    expect(client.rtdbConnectDatabaseEmulator()).toBeUndefined();
  });
});
