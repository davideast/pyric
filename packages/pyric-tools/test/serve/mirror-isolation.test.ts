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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectFirebaseBindings,
  pyricPackageRoot,
} from '../../src/serve/bundler.js';

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
