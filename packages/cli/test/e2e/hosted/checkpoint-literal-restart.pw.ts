import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

test('a plain SDK write and host restart keep an ordinary map whose fields resemble a timestamp marker', async ({ page }) => {
  const fixture = await startHostedFixture();
  const literal = { __type: 'timestamp', seconds: 5, nanos: 0, note: 'ordinary map' };
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await page.evaluate(async literal => {
      const { doc, getFirestore, setDoc } = await import('firebase/firestore');
      await setDoc(doc(getFirestore(), 'shared/literal'), { literal });
    }, literal);
    const readLiteral = () => page.evaluate(async () => {
      const { doc, getDoc, getFirestore } = await import('firebase/firestore');
      return (await getDoc(doc(getFirestore(), 'shared/literal'))).data()?.literal;
    });
    expect(await readLiteral()).toEqual(literal);
    await page.goto('about:blank');
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGKILL');
    await exited;
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      expect(await readLiteral()).toEqual(literal);
    } finally {
      await replacement.stop();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});
