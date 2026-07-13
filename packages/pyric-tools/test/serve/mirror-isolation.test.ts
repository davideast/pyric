/**
 * Ratchet for the client mirror's runtime production-SDK dependency graph.
 *
 * The Vite/import-map layer owns Firebase-versus-sandbox selection. Until the
 * legacy production arms are deleted, this fixture records their exact built
 * Firebase bindings. New bindings fail; deleting a binding also fails until
 * the fixture shrinks in the same change. The fixture reaches zero and is then
 * replaced by the packed-package isolation assertion.
 */
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectFirebaseBindings,
  pyricPackageRoot,
} from '../../src/serve/bundler.js';

function collectJavaScriptImports(root: string): string[] {
  const pending = [root];
  const imports: string[] = [];
  const transpiler = new Bun.Transpiler({ loader: 'js' });
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        imports.push(
          ...transpiler.scan(readFileSync(path, 'utf8')).imports.map(
            (moduleImport) => moduleImport.path,
          ),
        );
      }
    }
  }
  return imports;
}

const expected = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures/client-firebase-bindings.json'), 'utf8'),
) as Record<string, string[]>;

test('the client mirror does not acquire new production Firebase bindings', () => {
  const actual = Object.fromEntries(
    [...collectFirebaseBindings(join(pyricPackageRoot(), 'dist')).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([specifier, names]) => [specifier, [...names].sort()]),
  );

  expect(actual).toEqual(expected);
});

test('the pyric package does not own the Firebase Admin SDK', () => {
  const root = pyricPackageRoot();
  const manifest = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };

  expect(manifest.dependencies?.['firebase-admin']).toBeUndefined();
  expect(
    collectJavaScriptImports(join(root, 'dist')).filter(
      (specifier) =>
        specifier === 'firebase-admin' || specifier.startsWith('firebase-admin/'),
    ),
  ).toEqual([]);
});

test('the isolated AI declarations do not require firebase/ai', () => {
  const aiDist = join(pyricPackageRoot(), 'dist', 'ai');
  const declarations = readdirSync(aiDist)
    .filter((file) => file.endsWith('.d.ts'))
    .map((file) => readFileSync(join(aiDist, file), 'utf8'))
    .join('\n')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*'))
    .join('\n');

  expect(declarations).not.toMatch(/(?:from\s+|import\()["']firebase\/ai["']/);
});
