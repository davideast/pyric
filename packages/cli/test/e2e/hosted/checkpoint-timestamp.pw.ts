import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test, type Page } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

async function readTimestamp(page: Page) {
  return page.evaluate(async () => {
    const { doc, getDoc, getFirestore } = await import('firebase/firestore');
    const data = (await getDoc(doc(getFirestore(), 'shared/time'))).data();
    const isMissing = data === undefined;
    if (isMissing) throw new Error('Expected the timestamp document');
    return data.created.toMillis();
  });
}

test('a restored timestamp retains the SDK toMillis method', async ({ page }) => {
  const fixture = await startHostedFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await page.evaluate(async () => {
      const { Timestamp, doc, getFirestore, setDoc } = await import('firebase/firestore');
      await setDoc(doc(getFirestore(), 'shared/time'), { created: Timestamp.fromMillis(1700000000123) });
    });
    expect(await readTimestamp(page)).toBe(1700000000123);
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await control.channel.op({ method: 'checkpoint', name: 'time' });
      await control.channel.op({ method: 'restore', name: 'time' });
      expect(await readTimestamp(page)).toBe(1700000000123);
    } finally {
      control.close();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});
