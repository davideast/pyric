import { readFileSync } from 'node:fs';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

for (const mode of ['hosted', 'sharedworker'] as const) {
  test(`${mode} import updates active document and query listeners without reviving an unsubscribed listener`, async ({ browser }) => {
    test.setTimeout(30_000);
    const flags = ['--no-capture'];
    const isHosted = mode === 'hosted';
    if (isHosted) flags.push('--hosted');
    const fixture = await startSoakServe({
      flags,
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const writerContext = await browser.newContext();
    let observerContext = writerContext;
    if (isHosted) observerContext = await browser.newContext();
    try {
      const writer = await writerContext.newPage();
      const observer = await observerContext.newPage();
      for (const page of [writer, observer]) {
        await page.goto(fixture.info.url);
        await expect(page.locator('#document')).toHaveText('Empty');
      }
      await writer.evaluate(async () => {
        const { collection, doc, getFirestore, onSnapshot, setDoc } = await import('firebase/firestore');
        const reference = doc(getFirestore(), 'shared/greeting');
        const output = document.createElement('output');
        output.id = 'secondary';
        document.body.append(output);
        const stop = onSnapshot(reference, snapshot => { output.textContent = snapshot.data()?.message ?? 'Empty'; });
        window.addEventListener('stop-secondary', stop, { once: true });
        const queryOutput = document.createElement('output');
        queryOutput.id = 'query';
        document.body.append(queryOutput);
        onSnapshot(collection(getFirestore(), 'shared'), snapshot => {
          queryOutput.textContent = snapshot.docs.map(item => item.data().message).join(',');
        });
        await setDoc(reference, { message: 'Saved value' });
      });
      for (const page of [writer, observer]) await expect(page.locator('#document')).toHaveText('Saved value');
      await waitForPeer(fixture.info.url);
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        const exported = await control.channel.op({ method: 'exportState' });
        const hasBundle = typeof exported === 'object' && exported !== null && 'bundle' in exported;
        const isMissingBundle = !hasBundle;
        if (isMissingBundle) throw new Error('Expected an exported state bundle');
        const bundle = exported.bundle;
        const isInvalidBundle = typeof bundle !== 'string';
        if (isInvalidBundle) throw new Error('Expected a string state bundle');
        await writer.evaluate(async () => {
          const { doc, getFirestore, setDoc } = await import('firebase/firestore');
          await setDoc(doc(getFirestore(), 'shared/greeting'), { message: 'Before import' });
          await setDoc(doc(getFirestore(), 'shared/temporary'), { message: 'Transient' });
        });
        for (const page of [writer, observer]) await expect(page.locator('#document')).toHaveText('Before import');
        await expect(writer.locator('#query')).toHaveText('Before import,Transient');
        await expect(writer.locator('#secondary')).toHaveText('Before import');
        await writer.evaluate(async () => {
          window.dispatchEvent(new Event('stop-secondary'));
          const { doc, getDoc, getFirestore } = await import('firebase/firestore');
          await getDoc(doc(getFirestore(), 'shared/greeting'));
        });
        await expect(control.channel.op({ method: 'importState', bundle })).resolves.toEqual({ ok: true });
        for (const page of [writer, observer]) await expect(page.locator('#document')).toHaveText('Saved value');
        await expect(writer.locator('#query')).toHaveText('Saved value');
        await writer.getByRole('button', { name: 'Write shared document' }).click();
        await expect(writer.locator('#write-result')).toHaveText('Written');
        for (const page of [writer, observer]) {
          await expect(page.locator('#document')).toHaveText('Hello from the other browser');
        }
        await expect(writer.locator('#query')).toHaveText('Hello from the other browser');
        await expect(writer.locator('#secondary')).toHaveText('Before import');
      } finally {
        control.close();
      }
    } finally {
      await Promise.all([writerContext.close(), observerContext.close()]);
      await fixture.stop();
    }
  });
}
