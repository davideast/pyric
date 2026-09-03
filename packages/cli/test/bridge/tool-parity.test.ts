/**
 * Tool parity: the forwarded operations the bridge ADVERTISES
 * (`composeMcpTools`) must equal the operations the page peer EXECUTES
 * (`SANDBOX_OP_KEYS`). The first is composed from the Node factory map, the
 * second is read from the records under `src/bridge/tool-records/`.
 *
 * A drift here is the "operation 'X' is not registered with the connected
 * sandbox peer" bug: the bridge lists an operation an agent can call, but the
 * page can't execute it (succeed-at-list, fail-at-dispatch). This test makes
 * that drift a build failure.
 */
import { describe, expect, it } from 'bun:test';
import { composeMcpTools } from '../../src/bridge/server/tool-surface.js';
import { SANDBOX_OP_KEYS } from '../../src/bridge/client/dispatch.js';

describe('sandbox tool parity (advertised == executable)', () => {
  it('every advertised forwarded operation is executable by the page dispatcher (and vice versa)', () => {
    const advertised = composeMcpTools()
      .flatMap((tool) =>
        tool.ops.filter((op) => op.transport === 'forwarded').map((op) => `${tool.name}.${op.op}`),
      )
      .sort();
    const executable = [...SANDBOX_OP_KEYS].sort();
    expect(executable).toEqual(advertised);
  });

  it('includes the data-plane + inspect operations that regressed (the bug this guards)', () => {
    const keys = new Set(SANDBOX_OP_KEYS);
    for (const key of [
      'firestore_data.set',
      'firestore_data.get',
      'firestore_data.list',
      'firestore_data.update',
      'firestore_data.delete',
      'firestore_data.query',
      'sandbox.inspect',
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });
});
