import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  GENERATED_HEADER,
  NON_USER_FACING_EXPORTS,
  OUTPUT_ROOT,
  PUBLISHED_PACKAGE_DIRS,
  REPO_ROOT,
  discoverApiDescriptors,
  renderApiIndex,
} from './gen-api-docs';

const descriptors = discoverApiDescriptors();

describe('generated API reference inventory', () => {
  test('tracks every package packed for publication', () => {
    const packScript = readFileSync(join(REPO_ROOT, 'scripts', 'pack-packages.sh'), 'utf8');
    const block = packScript.match(/PACKAGES=\(([\s\S]*?)\n\)/)?.[1] ?? '';
    const packed = [...block.matchAll(/"packages\/([^"/]+)"/g)].map((match) => match[1]);
    expect([...PUBLISHED_PACKAGE_DIRS]).toEqual(packed);
  });

  test('gives every released export exactly one disposition', () => {
    const documented = new Set(
      descriptors.map((descriptor) => `${descriptor.packageDir}:${descriptor.exportKey}`),
    );
    for (const packageDir of PUBLISHED_PACKAGE_DIRS) {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, 'packages', packageDir, 'package.json'), 'utf8'),
      ) as { exports: Record<string, unknown>; pyricUnreleasedExports?: string[] };
      const unreleased = new Set(manifest.pyricUnreleasedExports ?? []);
      for (const exportKey of Object.keys(manifest.exports)) {
        const key = `${packageDir}:${exportKey}`;
        const internal = exportKey
          .replace(/^\.\//, '')
          .split('/')
          .includes('internal');
        const dispositions = [
          documented.has(key),
          unreleased.has(exportKey),
          internal,
          NON_USER_FACING_EXPORTS.has(key),
        ].filter(Boolean);
        expect(dispositions, `${key} must be documented or explicitly excluded`).toHaveLength(1);
      }
    }
  });

  test('uses unique stable routes backed by declaration entries', () => {
    expect(descriptors).toHaveLength(48);
    expect(new Set(descriptors.map(({ importPath }) => importPath)).size).toBe(48);
    expect(new Set(descriptors.map(({ slug }) => slug)).size).toBe(48);
    for (const descriptor of descriptors) {
      expect(existsSync(descriptor.typesPath), descriptor.importPath).toBeTrue();
      expect(descriptor.slug).toMatch(/^[a-z0-9-]+-reference-api$/);
    }
  });

  test('index and generated files cover the same route universe', () => {
    const index = readFileSync(join(REPO_ROOT, 'docs', 'api-reference', 'index.md'), 'utf8');
    expect(index).toBe(renderApiIndex(descriptors));
    const files = readdirSync(OUTPUT_ROOT).filter((file) => file.endsWith('.md')).sort();
    expect(files).toEqual(descriptors.map(({ slug }) => `${slug}.md`).sort());
    for (const descriptor of descriptors) {
      const markdown = readFileSync(descriptor.outputPath, 'utf8');
      expect(markdown).toContain(GENERATED_HEADER);
      expect(markdown).toContain(`apiImportPath: "${descriptor.importPath}"`);
      expect(markdown).toMatch(/apiSymbolCount: [1-9][0-9]*/);
      expect(markdown).not.toMatch(/^### `_.*`?$/m);
    }
  });
});
