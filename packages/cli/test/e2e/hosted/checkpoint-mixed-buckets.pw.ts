import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

interface SavedBucket { docs?: Record<string, unknown>; encoding?: string }

test('host startup reads legacy and declared-encoding buckets together', async ({ page }) => {
  const fixture = await startHostedFixture();
  const literal = { __type: 'timestamp', seconds: 5, nanos: 0, note: 'ordinary map' };
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await page.evaluate(async literal => {
      const { doc, getFirestore, setDoc, Timestamp } = await import('firebase/firestore');
      const db = getFirestore();
      await setDoc(doc(db, 'shared/legacy'), { timestamp: Timestamp.fromMillis(1700000000123) });
      await setDoc(doc(db, 'shared/current'), { literal });
    }, literal);
    await page.goto('about:blank');
    const exited = once(fixture.child, 'exit');
    fixture.child.kill('SIGKILL');
    await exited;
    const database = new DatabaseSync(join(fixture.dir, '.pyric/state/hosted/state.sqlite'));
    try {
      const buckets = database.prepare("SELECT id, payload FROM records WHERE namespace='hosted'").all().map(row => ({
        id: row.id, value: JSON.parse(String(row.payload)) as SavedBucket,
      }));
      const legacy = buckets.find(bucket => bucket.value.docs?.['shared/legacy'] !== undefined);
      const current = buckets.find(bucket => bucket.value.docs?.['shared/current'] !== undefined);
      expect(legacy).toBeDefined();
      expect(current).toBeDefined();
      expect(legacy).not.toBe(current);
      const missingLegacy = legacy === undefined;
      if (missingLegacy) throw new Error('Expected the persisted legacy document');
      delete legacy.value.encoding;
      database.prepare("UPDATE records SET payload=? WHERE namespace='hosted' AND id=?").run(JSON.stringify(legacy.value), legacy.id);
    } finally { database.close(); }
    const replacement = startHost(fixture.dir, fixture.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      await page.goto(fixture.info.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      const restored = await page.evaluate(async () => {
        const { doc, getDoc, getFirestore } = await import('firebase/firestore');
        const db = getFirestore();
        const legacy = (await getDoc(doc(db, 'shared/legacy'))).data();
        const current = (await getDoc(doc(db, 'shared/current'))).data();
        return { timestamp: legacy?.timestamp.toMillis(), literal: current?.literal };
      });
      expect(restored).toEqual({ timestamp: 1700000000123, literal });
    } finally {
      await replacement.stop();
    }
  } finally {
    await page.close();
    await fixture.stop();
  }
});
