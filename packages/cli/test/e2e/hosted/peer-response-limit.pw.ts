import { readFileSync } from 'node:fs';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

for (const operation of ['read', 'listen']) {
  test(`a SharedWorker peer refuses an oversized remote ${operation} without disconnecting healthy clients`, async ({ page }) => {
    const fixture = await startSoakServe({
      flags: ['--no-capture'],
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const sentBytes: number[] = [];
    let socketCloses = 0;
    page.on('websocket', socket => {
      socket.on('framesent', frame => { sentBytes.push(Buffer.byteLength(frame.payload)); });
      socket.on('close', () => { socketCloses += 1; });
    });
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await waitForPeer(fixture.info.url);
      await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        for (const index of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
          await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'large', index), { payload: 'é'.repeat(1024 * 1024) });
        }
      });
      const remote = await connectRemoteSandbox({ url: fixture.info.url });
      const healthy = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        const isRead = operation === 'read';
        if (isRead) {
          await expect(remote.channel.op({
            method: 'getDocs', source: { __ref: 'collection', path: 'large' }, actAs: { mode: 'admin' },
          })).rejects.toMatchObject({ code: 'resource-exhausted' });
        } else {
          const errors: string[] = [];
          const snapshots: unknown[] = [];
          const unsubscribe = remote.channel.subscribe(
            { target: { __ref: 'collection', path: 'large' }, actAs: { mode: 'admin' } },
            value => snapshots.push(value),
            error => errors.push(error.code),
          );
          try {
            await expect.poll(() => errors).toEqual(['resource-exhausted']);
            expect(snapshots).toEqual([]);
          } finally {
            unsubscribe();
          }
        }
        await healthy.channel.op({
          method: 'setDoc', path: 'shared/greeting', data: { message: 'Healthy after oversized peer reply' }, actAs: { mode: 'admin' },
        });
        await expect(page.locator('#document')).toHaveText('Healthy after oversized peer reply');
        await expect(remote.channel.op({
          method: 'getDoc', path: 'shared/greeting', actAs: { mode: 'admin' },
        })).resolves.toMatchObject({ exists: true });
        expect(socketCloses).toBe(0);
        expect(sentBytes.length).toBeGreaterThan(0);
        for (const bytes of sentBytes) expect(bytes).toBeLessThanOrEqual(12 * 1024 * 1024);
      } finally {
        remote.close();
        healthy.close();
      }
    } finally {
      await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
      await page.close();
      await fixture.stop();
    }
  });
}
