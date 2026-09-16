import { expect, test } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('hosted Storage returns a Blob and a download URL usable by another browser context', async ({
  browser,
}) => {
  const fixture = await startHostedFixture({
    'storage.rules':
      'rules_version = "2"; service firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if request.auth != null; } } }',
  });
  const sender = await browser.newPage();
  const recipient = await browser.newPage();
  try {
    await sender.goto(fixture.info.url);
    await expect(sender.locator('#document')).toHaveText('Empty');
    const downloaded = await sender.evaluate(async () => {
      const { getStorage, ref, uploadBytes, getBlob, getDownloadURL } =
        await import('firebase/storage');
      const reference = ref(getStorage(), 'attachments/checkpoint.txt');
      await uploadBytes(
        reference,
        new File(['Shared attachment'], 'checkpoint.txt', { type: 'text/plain' }),
      );
      const blob = await getBlob(reference);
      return { text: await blob.text(), type: blob.type, url: await getDownloadURL(reference) };
    });
    expect(downloaded.text).toBe('Shared attachment');
    expect(downloaded.type).toBe('text/plain');
    await recipient.goto(fixture.info.url);
    const received = await recipient.evaluate(
      async (url) => (await fetch(url)).text(),
      downloaded.url,
    );
    expect(received).toBe('Shared attachment');
  } finally {
    await sender.close();
    await recipient.close();
    await fixture.stop();
  }
});
