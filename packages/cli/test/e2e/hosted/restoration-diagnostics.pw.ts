import { once } from 'node:events';
import { expect, test } from '@playwright/test';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

test('host startup reports the number of Firestore documents actually restored', async ({ page }) => {
  const fixture = await startHostedFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await page.evaluate(async () => {
      const { doc, getFirestore, setDoc } = await import('firebase/firestore');
      const db = getFirestore();
      await setDoc(doc(db, 'shared/greeting'), { message: 'Restored greeting' });
      await setDoc(doc(db, 'shared/extra'), { message: 'Restored extra' });
    });
    await page.goto('about:blank');
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGKILL');
    await exited;
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Restored greeting');
      const documents = await page.evaluate(async () => {
        const { collection, getDocs, getFirestore } = await import('firebase/firestore');
        return (await getDocs(collection(getFirestore(), 'shared'))).docs.map(document => document.id).sort();
      });
      expect(documents).toEqual(['extra', 'greeting']);
      const readyLine = replacement.stdout().split('\n').find(line => line.startsWith('{'));
      const isMissingReadiness = readyLine === undefined;
      if (isMissingReadiness) throw new Error('Expected CLI readiness JSON');
      expect(JSON.parse(readyLine)).toMatchObject({ restoredDocs: 2, restoredUsers: 1 });
      expect(replacement.stderr()).toContain('(2 doc(s), 1 user(s) restored; --seed skipped)');
    } finally {
      await replacement.stop();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});

test('startup distinguishes a fresh host from restored Auth-only state', async ({ page }) => {
  const fixture = await startHostedFixture();
  try {
    expect(fixture.info).toMatchObject({ persist: true, restoredDocs: 0, restoredUsers: 0 });
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    const users = await control.auth.listUsers().finally(() => control.close());
    await page.goto('about:blank');
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGKILL');
    await exited;
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const readyLine = replacement.stdout().split('\n').find(line => line.startsWith('{'));
      const isMissingReadiness = readyLine === undefined;
      if (isMissingReadiness) throw new Error('Expected CLI readiness JSON');
      expect(JSON.parse(readyLine)).toMatchObject({ persist: true, restoredDocs: 0, restoredUsers: 1 });
      expect(replacement.stderr()).toContain('(0 doc(s), 1 user(s) restored; --seed skipped)');
      const restored = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        expect(await restored.auth.listUsers()).toEqual(users);
      } finally {
        restored.close();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});
