/**
 * Mirrored unit tests for `src/bridge/surface/functions-ephemeral-host.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { get as getRtdb, getAdminDatabase, ref as rtdbRef } from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { connectRemoteSandbox } from '../../../src/remote/index.js';
import { startEphemeralFunctionsHost } from '../../../src/bridge/surface/functions-ephemeral-host.js';

describe('startEphemeralFunctionsHost', () => {
  it('accepts authenticated remote sandbox connections, relays writes, and runs onDisconnect on close', async () => {
    const sandbox = initializeSandbox();
    const host = await startEphemeralFunctionsHost(sandbox, {
      projectId: 'org-alpha',
      defaultInstance: 'custom-rtdb',
    });
    try {
      const unauthInit = await fetch(`${host.serveUrl()}/__pyric/init.json`);
      expect(unauthInit.status).toBe(401);

      const authInit = await fetch(`${host.serveUrl()}/__pyric/init.json`, {
        headers: { 'x-pyric-session-token': host.sessionToken },
      });
      expect(authInit.status).toBe(200);

      const remote = await connectRemoteSandbox({
        url: host.serveUrl(),
        instanceId: host.instanceId,
        sessionToken: host.sessionToken,
      });
      await remote.rtdb.forInstance('custom-rtdb').set('items/i1', 'written');
      await remote.channel.op({
        method: 'rtdb.onDisconnectSet',
        instance: undefined,
        path: '/presence/c1',
        value: 'gone',
        actAs: { mode: 'admin' },
      });
      remote.close();
      await host.close();

      const db = getAdminDatabase(sandbox);
      expect((await getRtdb(rtdbRef(db, 'items/i1'))).val()).toBe('written');
      expect((await getRtdb(rtdbRef(db, 'presence/c1'))).val()).toBe('gone');
    } finally {
      await host.close();
      sandbox.dispose();
    }
  });
});
