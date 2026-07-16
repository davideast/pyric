import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
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

  test('index and generated routes cover the same route universe', () => {
    // Hermetic: _generated/ is gitignored and only exists after the site's
    // generate step, so derive BOTH sides in memory from the generator's own
    // pure functions rather than reading anything from disk. Content drift of
    // the written files is `bun run docs:api:check`'s job, not this test's.
    const index = renderApiIndex(descriptors);
    expect(index).toContain(GENERATED_HEADER);
    // Every descriptor route appears in the index exactly once, as a sibling
    // .md link in the shared flat _generated/ directory, and nothing else
    // links out of the index.
    const linked = [...index.matchAll(/\]\(\.\/([a-z0-9-]+)\.md\)/g)]
      .map((match) => match[1])
      .sort();
    expect(linked).toEqual(descriptors.map(({ slug }) => slug).sort());
    // Every route's output path lands in the shared _generated/ directory
    // under its own slug, so the written inventory cannot diverge from the
    // index's link universe.
    for (const descriptor of descriptors) {
      expect(descriptor.outputPath).toBe(join(OUTPUT_ROOT, `${descriptor.slug}.md`));
      expect(index).toContain(`[\`${descriptor.importPath}\`](./${descriptor.slug}.md)`);
    }
  });
});
