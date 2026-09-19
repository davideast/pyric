import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import type { Checkpoint } from 'pyric/sandbox/checkpoints';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

const corruptions = ['auth', 'firestore', 'storage', 'rules', 'account-record', 'storage-record',
  'object-bytes', 'storage-rules', 'database-version', 'object-path', 'object-root', 'object-size', 'counts', 'firestore-bytes'] as const;

function corruptedState(state: Checkpoint['state'], corruption: Exclude<typeof corruptions[number], 'counts'>) {
  switch (corruption) {
    case 'auth': return { ...state, auth: { users: null, providers: {} } };
    case 'firestore': return { ...state, firestore: null };
    case 'firestore-bytes': return { ...state, firestore: { 'shared/broken': { value: { __type: 'bytes' } } } };
    case 'storage': return { ...state, storage: null };
    case 'rules': return { ...state, rules: null };
    case 'account-record': return { ...state, auth: { users: [null], providers: {} } };
    case 'storage-record': return { ...state, storage: [null] };
    case 'object-bytes': return { ...state, storage: [{ path: 'broken.bin', contentBase64: '!!!', customMetadata: {} }] };
    case 'storage-rules': return { ...state, rules: { ...state.rules, storage: 'rules_version = ; broken' } };
    case 'database-version': return { ...state, database: { '.pyricRtdbPersistence': 999, data: null, priorities: {} } };
    case 'object-path': return { ...state, storage: [{ path: '', contentBase64: 'AA==', customMetadata: {} }] };
    case 'object-root': return { ...state, storage: [{ path: '///', contentBase64: 'AA==', customMetadata: {} }] };
    case 'object-size': return { ...state, storage: [{ path: 'broken.bin', contentBase64: 'AA==', customMetadata: {},
      metadata: { name: 'broken.bin', bucket: 'pyric-default', generation: '1', metageneration: '1',
        timeCreated: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', size: 999 } }] };
  }
}

test('a checkpoint can retain intentionally invalid Firestore rules during editing', async ({ page }) => {
  const fixture = await startHostedFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const control = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await expect(control.channel.op({ method: 'setFirestoreRules', source: 'rules_version = ; unfinished' }))
        .resolves.toMatchObject({ ok: false });
      await expect(control.channel.op({ method: 'checkpoint', name: 'editing' })).resolves.toMatchObject({ ok: true });
      await expect(control.channel.op({ method: 'restore', name: 'editing' })).resolves.toMatchObject({ ok: true });
    } finally {
      control.close();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});

for (const service of corruptions) {
  test(`a malformed checkpoint ${service} refuses before replacing healthy SDK state`, async ({ page }) => {
    const fixture = await startHostedFixture();
    try {
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      const control = await connectRemoteSandbox({ url: fixture.info.url });
      try {
        await control.channel.op({ method: 'checkpoint', name: 'broken' });
        await page.evaluate(async () => {
          const { doc, getFirestore, setDoc } = await import('firebase/firestore');
          await setDoc(doc(getFirestore(), 'shared/greeting'), { message: 'Healthy current state' });
        });
        const usersBefore = await control.auth.listUsers();
        const path = join(fixture.dir, '.pyric', 'state', 'checkpoints', 'broken.json');
        const checkpoint: Checkpoint = JSON.parse(readFileSync(path, 'utf8'));
        const corruptsCounts = service === 'counts';
        const corrupted = corruptsCounts
          ? { ...checkpoint, counts: null }
          : { ...checkpoint, state: corruptedState(checkpoint.state, service) };
        writeFileSync(path, JSON.stringify(corrupted));
        const outcome = await control.channel.op({ method: 'restore', name: 'broken' }).catch(() => null);
        expect(outcome).not.toEqual(expect.objectContaining({ ok: true }));
        const current = await page.evaluate(async () => {
          const { doc, getDoc, getFirestore } = await import('firebase/firestore');
          return (await getDoc(doc(getFirestore(), 'shared/greeting'))).data();
        });
        expect(current).toEqual({ message: 'Healthy current state' });
        expect(await control.auth.listUsers()).toEqual(usersBefore);
        await page.evaluate(async () => {
          const { doc, getFirestore, setDoc } = await import('firebase/firestore');
          await setDoc(doc(getFirestore(), 'shared/after-refusal'), { message: 'Still writable' });
        });
        const checksRestart = service === 'auth';
        if (checksRestart) {
          control.close();
          await page.goto('about:blank');
          const exited = once(fixture.child, 'exit');
          fixture.child.kill('SIGKILL');
          await exited;
          const replacement = startHost(fixture.dir, fixture.info.port);
          try {
            expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
            await page.goto(fixture.info.url);
            await expect(page.locator('#document')).toHaveText('Healthy current state');
          } finally {
            await replacement.stop();
          }
        }
      } finally {
        control.close();
      }
    } finally {
      await page.close();
      await fixture.stop();
    }
  });
}
