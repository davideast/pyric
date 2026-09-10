import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFunctionsModuleExports } from '../../src/functions-rtdb/module-loader.js';

function projectAt(type: 'module' | 'commonjs' | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-functions-module-loader-'));
  const packageJson: Record<string, unknown> = { name: 'fixture', private: true };
  if (type !== undefined) packageJson.type = type;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(packageJson), 'utf8');
  return dir;
}

describe('loadFunctionsModuleExports', () => {
  test('loads an ESM entry when the nearest package.json declares "type": "module"', async () => {
    const dir = projectAt('module');
    const entry = join(dir, 'index.js');
    writeFileSync(entry, 'export const marker = "esm";\n', 'utf8');
    const exported = await loadFunctionsModuleExports(entry);
    expect(exported.marker).toBe('esm');
  });

  test('loads a CommonJS entry when the nearest package.json omits "type"', async () => {
    const dir = projectAt(undefined);
    const entry = join(dir, 'index.js');
    writeFileSync(entry, 'exports.marker = "cjs";\n', 'utf8');
    const exported = await loadFunctionsModuleExports(entry);
    expect(exported.marker).toBe('cjs');
  });

  test('an explicit .cjs extension loads as CommonJS regardless of package scope', async () => {
    const dir = projectAt('module');
    const entry = join(dir, 'index.cjs');
    writeFileSync(entry, 'exports.marker = "forced-cjs";\n', 'utf8');
    const exported = await loadFunctionsModuleExports(entry);
    expect(exported.marker).toBe('forced-cjs');
  });

  test('an explicit .mjs extension loads as ESM regardless of package scope', async () => {
    const dir = projectAt('commonjs');
    const entry = join(dir, 'index.mjs');
    writeFileSync(entry, 'export const marker = "forced-esm";\n', 'utf8');
    const exported = await loadFunctionsModuleExports(entry);
    expect(exported.marker).toBe('forced-esm');
  });
});
