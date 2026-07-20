import { describe, expect, it } from 'bun:test';
import { rpcWithTimeout, wirePort } from '../../../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../../../src/serve/worker/client/handles.js';

describe('worker client RPC timeout', () => {
  it('rejects a bounded RPC and ignores its late response', async () => {
    const port: ClientPort = {
      onmessage: null,
      postMessage() {},
      start() {},
      close() {},
    };
    wirePort(port);

    const request = rpcWithTimeout(
      port,
      { t: 'op', id: 'slow-operation', method: 'getRuntimeEpoch' },
      5,
      'worker did not answer',
    );
    await expect(request).rejects.toThrow('worker did not answer');

    expect(() => port.onmessage?.({
      data: { t: 'res', id: 'slow-operation', ok: true, value: { version: 'late' } },
    } as MessageEvent)).not.toThrow();
  });
});
