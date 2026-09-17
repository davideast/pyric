import { setPersistenceWritable } from './persistence-fault.js';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

test('an acknowledged hosted checkpoint survives termination and restores its saved SDK data', async ({ browser }) => {
  const fixture = await startHostedFixture();
  const writer = await browser.newPage();
  try {
    await writer.goto(fixture.info.url);
    await expect(writer.locator('#document')).toHaveText('Empty');
    await writer.getByRole('button', { name: 'Write shared document', exact: true }).click();
    await expect(writer.locator('#document')).toHaveText('Hello from the other browser');
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await expect(control.channel.op({ method: 'checkpoint', name: 'saved' })).resolves.toMatchObject({
        ok: true, counts: { firestore: 1 },
      });
      const exit = once(fixture.child, 'exit');
      fixture.child.kill('SIGKILL');
      await exit;
    } finally {
      control.close();
    }
    await writer.close();
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const restoredControl = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await expect(restoredControl.channel.op({ method: 'listCheckpoints' })).resolves.toMatchObject({
          checkpoints: [{ name: 'saved', counts: { firestore: 1 } }],
        });
        const reader = await browser.newPage();
        try {
          await reader.goto(fixture.info.url);
          await expect(reader.locator('#document')).toHaveText('Hello from the other browser');
          await reader.evaluate(async () => {
            const { doc, getFirestore, setDoc } = await import('firebase/firestore');
            await setDoc(doc(getFirestore(), 'shared', 'greeting'), { message: 'After checkpoint' });
          });
          await expect(reader.locator('#document')).toHaveText('After checkpoint');
          await expect(restoredControl.channel.op({ method: 'restore', name: 'saved' })).resolves.toMatchObject({ ok: true });
          await expect(reader.locator('#document')).toHaveText('Hello from the other browser');
        } finally {
          await reader.close();
        }
      } finally {
        restoredControl.close();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    await writer.close();
    await fixture.stop();
  }
});

test('checkpoint restore re-establishes explicit admin listeners and respects unsubscribe', async ({ page }) => {
  const fixture = await startHostedFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await page.getByRole('button', { name: 'Write shared document', exact: true }).click();
    await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      const received: unknown[] = [];
      const unsubscribe = control.channel.subscribe(
        { target: { __ref: 'doc', path: 'shared/greeting' }, actAs: { mode: 'admin' } },
        snapshot => received.push(snapshot),
      );
      try {
        await expect.poll(() => received.at(-1)).toMatchObject({ data: { json: '{"message":"Hello from the other browser"}' } });
        await expect(control.channel.op({ method: 'checkpoint', name: 'saved' })).resolves.toMatchObject({ ok: true });
        await page.evaluate(async () => {
          const { doc, getFirestore, setDoc } = await import('firebase/firestore');
          await setDoc(doc(getFirestore(), 'shared/greeting'), { message: 'After checkpoint' });
        });
        await expect.poll(() => received.at(-1)).toMatchObject({ data: { json: '{"message":"After checkpoint"}' } });
        await expect(control.channel.op({ method: 'restore', name: 'saved' })).resolves.toMatchObject({ ok: true });
        await expect.poll(() => received.at(-1)).toMatchObject({ data: { json: '{"message":"Hello from the other browser"}' } });
        unsubscribe();
        // This ordered control reply confirms the preceding unsubscribe was processed.
        await control.channel.op({ method: 'listCheckpoints' });
        const countAfterUnsubscribe = received.length;
        await expect(control.channel.op({ method: 'restore', name: 'saved' })).resolves.toMatchObject({ ok: true });
        await page.evaluate(async () => {
          const { doc, getFirestore, setDoc } = await import('firebase/firestore');
          await setDoc(doc(getFirestore(), 'shared/greeting'), { message: 'After unsubscribe' });
        });
        await control.channel.op({ method: 'listCheckpoints' });
        expect(received).toHaveLength(countAfterUnsubscribe);
      } finally {
        unsubscribe();
      }
    } finally {
      control.close();
    }
  } finally {
    await fixture.stop();
  }
});

test('checkpoint restore reports failed durability and refuses another restore while unhealthy', async ({ page }) => {
  const fixture = await startHostedFixture();
  const stateDirectory = join(fixture.dir, '.pyric', 'state');
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await expect(control.channel.op({ method: 'checkpoint', name: 'empty' })).resolves.toMatchObject({ ok: true });
      await page.getByRole('button', { name: 'Write shared document', exact: true }).click();
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
      await expect(control.channel.op({ method: 'checkpoint', name: 'saved' })).resolves.toMatchObject({ ok: true });
      await page.evaluate(async () => {
        const { doc, getFirestore, setDoc } = await import('firebase/firestore');
        await setDoc(doc(getFirestore(), 'shared/greeting'), { message: 'After checkpoint' });
      });
      await expect(page.locator('#document')).toHaveText('After checkpoint');
      setPersistenceWritable(stateDirectory, false);

      await expect(control.channel.op({ method: 'restore', name: 'saved' })).rejects.toMatchObject({ code: 'committed-but-not-durable' });
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
      await expect(control.channel.op({ method: 'restore', name: 'empty' })).rejects.toMatchObject({ code: 'persistence-unhealthy' });
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
    } finally {
      control.close();
    }
  } finally {
    setPersistenceWritable(stateDirectory, true);
    await fixture.stop();
  }
});

test('default SharedWorker checkpoints restore SDK listeners through the record backend', async ({ page }) => {
  const fixture = await startSoakServe({
    flags: ['--no-capture'],
    extraFiles: {
      'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
      'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    },
  });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await expect.poll(() => page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('shared-worker');
    await waitForPeer(fixture.info.url);
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await page.getByRole('button', { name: 'Write shared document', exact: true }).click();
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
      await expect(control.channel.op({ method: 'checkpoint', name: 'saved' })).resolves.toMatchObject({ ok: true });
      await page.evaluate(async () => {
        const { doc, getFirestore, setDoc } = await import('firebase/firestore');
        await setDoc(doc(getFirestore(), 'shared/greeting'), { message: 'After checkpoint' });
      });
      await expect(page.locator('#document')).toHaveText('After checkpoint');
      await expect(control.channel.op({ method: 'restore', name: 'saved' })).resolves.toMatchObject({ ok: true });
      await expect(page.locator('#document')).toHaveText('Hello from the other browser');
      await expect(control.channel.op({ method: 'listCheckpoints' })).resolves.toMatchObject({
        checkpoints: [{ name: 'saved', counts: { firestore: 1 } }],
      });
    } finally {
      control.close();
    }
  } finally {
    await fixture.stop();
  }
});
