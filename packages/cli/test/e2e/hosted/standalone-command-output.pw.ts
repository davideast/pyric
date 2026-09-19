import { expect, test } from '@playwright/test';
import { startServer } from '@pyric/cli/bridge';
import { connectBridge } from '@pyric/cli/bridge/client';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getDoc, getAdminFirestore } from 'pyric/firestore';

test('standalone refuses an oversized tool command without disconnecting its peer', async () => {
  const server = await startServer({ port: 0, silent: true, disableAuditLog: true });
  const sandbox = initializeSandbox();
  let connected = false;
  let disconnections = 0;
  const peer = connectBridge(sandbox, {
    url: server.url.replace('http:', 'ws:') + '/sandbox', noReconnect: true,
    onStateChange: state => {
      connected = state.kind === 'connected';
      const isDisconnected = state.kind === 'disconnected';
      if (isDisconnected) disconnections += 1;
    },
  });
  try {
    await expect.poll(() => connected).toBe(true);
    const result = await server.bridge.dispatch('firestore_create_document', {
      path: 'shared/refused', data: { message: 'é'.repeat(6 * 1024 * 1024) },
    });
    expect(result).toMatchObject({ ok: false, summary: 'Bridge request exceeds the 12 MiB encoded frame limit.' });
    const firestore = getAdminFirestore(sandbox);
    expect((await getDoc(doc(firestore, 'shared/refused'))).data()).toBeUndefined();
    const healthy = await server.bridge.dispatch('firestore_create_document', {
      path: 'shared/healthy', data: { message: 'Still connected' },
    });
    expect(healthy.ok).toBe(true);
    expect((await getDoc(doc(firestore, 'shared/healthy'))).data()).toEqual({ message: 'Still connected' });
    expect(connected).toBe(true);
    expect(disconnections).toBe(0);
  } finally {
    peer.disconnect();
    sandbox.dispose();
    await server.stop();
  }
});
