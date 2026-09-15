import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import type { Checkpoint } from 'pyric/sandbox/checkpoints';
import { bundleRecords, checksumDocs } from '../../../../pyric/dist/sandbox/persistence/chunk-format.js';
import { startHostedFixture } from './fixture.js';

test('over-depth state replacement refuses before changing healthy service state', async ({ page }) => {
  const fixture = await startHostedFixture();
  try {
    await page.goto(fixture.info.url);
    await page.locator('#write').click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    const remote = await connectRemoteSandbox({ url: fixture.info.url, opTimeoutMs: 3_000 });
    try {
      await remote.rtdb.set('preserved', { message: 'Original tree' });
      await remote.storage.putBytes('preserved.bin', Uint8Array.of(0, 128, 255));
      await remote.channel.op({ method: 'checkpoint', name: 'depth' });
      const file = join(fixture.dir, '.pyric/state/checkpoints/depth.json');
      const checkpoint: Checkpoint = JSON.parse(readFileSync(file, 'utf8'));
      const tooDeep: Record<string, unknown> = JSON.parse('{"nested":'.repeat(65) + 'null' + '}'.repeat(65));
      async function readState(): Promise<unknown> {
        const exported = await remote.channel.op({ method: 'exportState' });
        const isRecord = exported !== null && typeof exported === 'object' && 'bundle' in exported;
        const bundle = isRecord ? exported.bundle : undefined;
        const hasBundle = typeof bundle === 'string';
        if (hasBundle) {
          const checkpoint: Checkpoint = JSON.parse(bundle);
          return checkpoint.state;
        }
        throw new Error('Expected the exported checkpoint');
      }
      const before = await readState();
      for (const encoding of ['declared', 'legacy']) {
        const replacement = structuredClone(checkpoint);
        replacement.state.firestore = { 'shared/deep': tooDeep };
        const isLegacy = encoding === 'legacy';
        if (isLegacy) delete replacement.state.firestoreEncoding;
        writeFileSync(file, JSON.stringify(replacement));
        await expect(remote.channel.op({ method: 'restore', name: 'depth' })).rejects.toMatchObject({ code: 'invalid-argument' });
        await expect(remote.channel.op({ method: 'importState', bundle: JSON.stringify(replacement) })).rejects.toMatchObject({ code: 'invalid-argument' });
        expect(await readState()).toEqual(before);
      }
      const documents = { 'shared/deep': tooDeep };
      const bundle = bundleRecords(new Map<string, unknown>([
        ['meta', { version: 3, savedAt: 0, services: {} }],
        ['00', { docs: documents, encoding: 'pyric/firestore-values/1', checksum: checksumDocs(documents) }],
      ]));
      await expect(remote.channel.op({ method: 'importState', bundle })).rejects.toMatchObject({ code: 'invalid-argument' });
      expect(await readState()).toEqual(before);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
    } finally {
      remote.close();
    }
  } finally {
    await page.close().finally(() => fixture.stop());
  }
});
