import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost } from './host-process.js';

const invalidStates = [
  { name: 'malformed JSON', content: 'secret42 private42', diagnostic: 'not valid JSON' },
  { name: 'envelope version', content: JSON.stringify({ version: 'secret42 private42' }), diagnostic: 'version (invalid)' },
  { name: 'controller version', content: JSON.stringify({ version: 1, firestore: { version: 'secret42 private42' } }), diagnostic: 'blob of version (invalid)' },
  { name: 'Auth records', content: JSON.stringify({ version: 1, auth: { users: 'secret42 private42' } }), diagnostic: 'invalid Auth or Storage records' },
];

for (const invalid of invalidStates) {
test(`hosted restoration refuses ${invalid.name} without disclosing private values and recovers after repair`, async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-phase-six-restore-'));
  const stateDir = join(dir, '.pyric', 'state');
  const statePath = join(stateDir, 'state.json');
  mkdirSync(stateDir, { recursive: true });
  for (const name of ['index.html', 'main.js']) {
    writeFileSync(join(dir, name), readFileSync(new URL(`./fixture/${name}`, import.meta.url)));
  }
  writeFileSync(join(dir, 'firestore.rules'), 'service cloud.firestore { match /databases/{db}/documents { match /shared/{id} { allow read, write: if request.auth != null; } } }');
  const corrupt = invalid.content;
  writeFileSync(statePath, corrupt);
  const failed = startHost(dir);
  try {
    expect(await failed.startup).toEqual({ kind: 'exit', code: 2 });
    expect(failed.stderr()).toContain(invalid.diagnostic);
    expect(failed.stdout()).not.toContain('"url"');
    expect(failed.stderr()).not.toContain('secret42');
    expect(failed.stderr()).not.toContain('private42');
    expect(readFileSync(statePath, 'utf8')).toBe(corrupt);
    rmSync(statePath);
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
