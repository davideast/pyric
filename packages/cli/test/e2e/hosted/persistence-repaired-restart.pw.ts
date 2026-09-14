import { once } from 'node:events';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';
import { startStoragePersistenceFixture } from './storage-persistence-fixture.js';

/** Observe acknowledgment and the resulting data through the same SDK caller. */
async function incrementCounter(page: Page) {
  return page.evaluate(async () => {
    const { doc, getDoc, getFirestore, increment, updateDoc } = await import('firebase/firestore');
    const reference = doc(getFirestore(), 'shared/greeting');
    let outcome = 'acknowledged';
    try {
      await updateDoc(reference, { count: increment(1) });
    } catch (error) {
      const hasCode = error instanceof Error && 'code' in error;
      if (hasCode) outcome = String(error.code);
      else throw error;
    }
    return { outcome, data: (await getDoc(reference)).data() };
  });
}

test('repairing storage and restarting recovers durable state without replaying an uncertain increment', async ({ browser }) => {
  test.setTimeout(30_000);
  const fixture = await startHostedFixture();
  const stateDirectory = join(fixture.dir, '.pyric', 'state');
  const context = await browser.newContext();
  try {
    const writer = await context.newPage();
    await writer.goto(fixture.info.url);
    await expect(writer.locator('#document')).toHaveText('Empty');
    await writer.evaluate(async () => {
      const { doc, getFirestore, setDoc } = await import('firebase/firestore');
      await setDoc(doc(getFirestore(), 'shared/greeting'), { message: 'Durable', count: 10 });
    });
    chmodSync(stateDirectory, 0o500);
    expect(await incrementCounter(writer)).toEqual({
      outcome: 'committed-but-not-durable', data: { message: 'Durable', count: 11 },
    });
    expect(await incrementCounter(writer)).toEqual({
      outcome: 'persistence-unhealthy', data: { message: 'Durable', count: 11 },
    });
    chmodSync(stateDirectory, 0o700);
    expect(await incrementCounter(writer)).toEqual({
      outcome: 'persistence-unhealthy', data: { message: 'Durable', count: 11 },
    });
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGKILL');
    await exited;
    chmodSync(stateDirectory, 0o700);

    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const reader = writer;
      try {
        await expect(reader.locator('#document')).toHaveText('Durable');
        await expect.poll(() => reader.evaluate(async () => {
          const { doc, getDoc, getFirestore } = await import('firebase/firestore');
          return (await getDoc(doc(getFirestore(), 'shared/greeting'))).data();
        }).catch(error => String(error))).toEqual({ message: 'Durable', count: 10 });
        expect(await incrementCounter(reader)).toEqual({
          outcome: 'acknowledged', data: { message: 'Durable', count: 11 },
        });
      } finally {
        await reader.close();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    chmodSync(stateDirectory, 0o700);
    await context.close();
    await fixture.stop();
  }
});

test('repairing storage and restarting restores durable object bytes and accepts new uploads', async ({ browser }) => {
  test.setTimeout(30_000);
  const fixture = await startStoragePersistenceFixture();
  const stateDirectory = join(fixture.dir, '.pyric', 'state');
  const context = await browser.newContext();
  try {
    const writer = await context.newPage();
    await writer.goto(fixture.info.url);
    await expect(writer.locator('#ready')).toHaveText('Ready');
    await writer.getByLabel('Value', { exact: true }).fill('Durable bytes');
    await writer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(writer.locator('#saved')).toHaveText('Saved');
    chmodSync(stateDirectory, 0o500);
    await writer.getByLabel('Value', { exact: true }).fill('Uncertain bytes');
    await writer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(writer.locator('#saved')).toHaveText('committed-but-not-durable');
    await writer.getByLabel('Value', { exact: true }).fill('Refused bytes');
    await writer.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(writer.locator('#saved')).toHaveText('persistence-unhealthy');
    await writer.getByRole('button', { name: 'Read', exact: true }).click();
    await expect(writer.locator('#value-read')).toHaveText('Uncertain bytes');
    chmodSync(stateDirectory, 0o700);
    const repairedAdmission = await writer.evaluate(async () => {
      const { getStorage, ref, uploadBytes } = await import('firebase/storage');
      try {
        await uploadBytes(ref(getStorage(), 'files/shared.txt'), new TextEncoder().encode('Must still refuse'));
        return 'acknowledged';
      } catch (error) {
        const hasCode = error instanceof Error && 'code' in error;
        if (hasCode) return String(error.code);
        throw error;
      }
    });
    expect(repairedAdmission).toBe('persistence-unhealthy');
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGKILL');
    await exited;
    await context.close();
    chmodSync(stateDirectory, 0o700);

    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const reader = await browser.newPage();
      try {
        await reader.goto(fixture.info.url);
        await expect(reader.locator('#ready')).toHaveText('Ready');
        await reader.getByRole('button', { name: 'Read', exact: true }).click();
        await expect(reader.locator('#value-read')).toHaveText('Durable bytes');
        await reader.getByLabel('Value', { exact: true }).fill('Recovered bytes');
        await reader.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(reader.locator('#saved')).toHaveText('Saved');
        await reader.getByRole('button', { name: 'Read', exact: true }).click();
        await expect(reader.locator('#value-read')).toHaveText('Recovered bytes');
      } finally {
        await reader.close();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    chmodSync(stateDirectory, 0o700);
    await context.close();
    await fixture.stop();
  }
});
