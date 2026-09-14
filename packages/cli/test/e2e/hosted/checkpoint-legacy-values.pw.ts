import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import type { Checkpoint } from 'pyric/sandbox/checkpoints';
import { startHostedFixture } from './fixture.js';

test('legacy checkpoints retain ordinary maps without a value encoding declaration', async ({ page }) => {
  const fixture = await startHostedFixture();
  const literal = { __type: 'timestamp', seconds: 5, nanos: 0, note: 'legacy map' };
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await control.channel.op({ method: 'checkpoint', name: 'legacy' });
      const path = join(fixture.dir, '.pyric', 'state', 'checkpoints', 'legacy.json');
      const checkpoint: Checkpoint = JSON.parse(readFileSync(path, 'utf8'));
      delete checkpoint.state.firestoreEncoding;
      checkpoint.state.firestore = { 'shared/legacy': { literal } };
      checkpoint.counts.firestore = 1;
      writeFileSync(path, JSON.stringify(checkpoint));
      await expect(control.channel.op({ method: 'restore', name: 'legacy' })).resolves.toMatchObject({ ok: true });
      const restored = await page.evaluate(async () => {
        const { doc, getDoc, getFirestore } = await import('firebase/firestore');
        return (await getDoc(doc(getFirestore(), 'shared/legacy'))).data();
      });
      expect(restored).toEqual({ literal });
    } finally {
      control.close();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});
