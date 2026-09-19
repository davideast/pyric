import { openHostedDatabase } from '../../../src/serve/hosted/persistence/database.js';
import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost } from './host-process.js';

const invalidStates = [
  { name: 'physical database', payload: null },
  { name: 'record JSON', payload: 'secret42 private42' },
  { name: 'controller version', payload: JSON.stringify({ version: 'secret42 private42' }) },
  { name: 'Auth records', payload: JSON.stringify({ version: 3, savedAt: 0, services: { auth: { users: 'secret42 private42' } } }) },
];

for (const invalid of invalidStates) {
test(`hosted restoration refuses ${invalid.name} without disclosing private values and recovers after repair`, async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-phase-six-restore-'));
  const stateDir = join(dir, '.pyric', 'state', 'hosted');
  const statePath = join(stateDir, 'state.sqlite');
  mkdirSync(stateDir, { recursive: true });
  for (const name of ['index.html', 'main.js']) {
    writeFileSync(join(dir, name), readFileSync(new URL(`./fixture/${name}`, import.meta.url)));
  }
  writeFileSync(join(dir, 'firestore.rules'), 'service cloud.firestore { match /databases/{db}/documents { match /shared/{id} { allow read, write: if request.auth != null; } } }');
  const physicalCorruption = invalid.payload === null;
  if (physicalCorruption) writeFileSync(statePath, 'secret42 private42');
  else {
    const database = await openHostedDatabase(stateDir);
    try { database.connection.prepare('INSERT INTO records VALUES (?, ?, ?)').run('hosted', 'meta', invalid.payload); }
    finally { database.close(); }
  }
  const corrupt = readFileSync(statePath);
  const failed = startHost(dir);
  try {
    expect(await failed.startup).toEqual({ kind: 'exit', code: 2 });
    expect(failed.stderr()).toContain('Hosted state could not be restored');
    expect(failed.stdout()).not.toContain('"url"');
    expect(failed.stderr()).not.toContain('secret42');
    expect(failed.stderr()).not.toContain('private42');
    expect(readFileSync(statePath)).toEqual(corrupt);
    rmSync(stateDir, { recursive: true });
    const repaired = startHost(dir);
    try {
      expect(await repaired.startup).toEqual({ kind: 'ready' });
      const line = repaired.stdout().split('\n').find(line => line.startsWith('{'));
      const missing = line === undefined;
      if (missing) throw new Error('Missing readiness');
      const ready: { url: string } = JSON.parse(line);
      await page.goto(ready.url);
      await expect(page.locator('#document')).toHaveText('Empty');
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('hosted');
      expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().errors)).toEqual([]);
    } finally {
      await page.close();
      await repaired.stop();
    }
  } finally {
    await failed.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
}
