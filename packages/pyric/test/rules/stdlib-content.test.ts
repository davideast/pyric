/**
 * Drift check for `src/modules/stdlib-content.ts`.
 *
 * `stdlib-content.ts` is a build-time inline of every bundled `.rules` file
 * under `src/modules/stdlib/`. The inliner runs as part of `prebuild`,
 * so a fresh build always picks up edits. But the inlined file is
 * checked in too — if someone edits a `.rules` file and forgets to
 * commit the regenerated inline, the source-of-truth disk content
 * and the bundled browser content drift apart.
 *
 * This test reads every `.rules` file off disk and asserts the
 * inline carries the identical content. Failure means "run
 * `bun run inline-stdlib` and commit the result".
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STDLIB_INLINE } from '../../src/rules/modules/stdlib-content.js';
import { STDLIB_SERVICE_CONTRACT_MODULES } from '../../src/rules/modules/resolver-core.js';
import { STDLIB_SERVICE_CONTRACTS } from '../../src/rules/modules/stdlib-services.generated.js';
import packageJson from '../../package.json';

const STDLIB_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/rules/modules/stdlib',
);

describe('STDLIB_INLINE — drift check against disk', () => {
  const diskFiles = readdirSync(STDLIB_DIR, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.rules'))
    .sort();

  it('covers the same set of modules as the disk directory', () => {
    const inlineKeys = Object.keys(STDLIB_INLINE).sort();
    const diskKeys = diskFiles.map((f) => f.replace(/\.rules$/, '')).sort();
    expect(inlineKeys).toEqual(diskKeys);
  });

  it('requires an explicit service contract for every bundled module', () => {
    const diskKeys = diskFiles.map((f) => f.replace(/\.rules$/, '')).sort();
    expect(STDLIB_SERVICE_CONTRACT_MODULES).toEqual(diskKeys);
  });

  it('makes stdlib generation a mandatory package build step', () => {
    expect(packageJson.scripts.prebuild).toContain('bun run inline-stdlib');
    expect(packageJson.scripts.prebuild).not.toMatch(/inline-stdlib[^&]*\|\|\s*true/);
  });

  it('derives service contracts from each module-owned declaration', () => {
    for (const moduleName of STDLIB_SERVICE_CONTRACT_MODULES) {
      const content = readFileSync(join(STDLIB_DIR, `${moduleName}.rules`), 'utf-8');
      const declaration = content.split('\n', 1)[0]?.match(/^\/\/ @pyric-services (.+)$/);
      expect(declaration, `${moduleName} must own its service declaration`).not.toBeNull();
      const expected = declaration![1]!.split(',');
      expect(STDLIB_SERVICE_CONTRACTS[moduleName as keyof typeof STDLIB_SERVICE_CONTRACTS])
        .toEqual(expected);
    }
  });

  for (const file of diskFiles) {
    const name = file.replace(/\.rules$/, '');
    it(`${name} — inline content matches disk`, () => {
      const onDisk = readFileSync(join(STDLIB_DIR, file), 'utf-8');
      expect(
        STDLIB_INLINE[name],
        `STDLIB_INLINE.${name} drifted from disk — run \`bun run inline-stdlib\` and commit`,
      ).toBe(onDisk);
    });
  }
});
