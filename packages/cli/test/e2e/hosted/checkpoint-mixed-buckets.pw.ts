import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

interface SavedBuckets {
  firestore: { records: Record<string, { docs?: Record<string, unknown>; encoding?: string }> };
}

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
    const path = join(fixture.dir, '.pyric', 'state', 'state.json');
    const saved: SavedBuckets = JSON.parse(readFileSync(path, 'utf8'));
    const buckets = Object.values(saved.firestore.records);
    const legacy = buckets.find(bucket => bucket.docs?.['shared/legacy'] !== undefined);
    const current = buckets.find(bucket => bucket.docs?.['shared/current'] !== undefined);
    expect(legacy).toBeDefined();
    expect(current).toBeDefined();
    expect(legacy).not.toBe(current);
    const isMissingLegacyBucket = legacy === undefined;
    if (isMissingLegacyBucket) throw new Error('Expected the persisted legacy document');
    delete legacy.encoding;
    writeFileSync(path, JSON.stringify(saved));
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
