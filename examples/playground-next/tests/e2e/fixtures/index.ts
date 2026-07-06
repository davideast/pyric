/**
 * Fixture loader — reads the appSource and rules as strings so the
 * test can pass them through `window.__pyricTestSeed` into the
 * workspace store. The appSource is loaded as raw text (not
 * imported); the bundler must not transform it before the
 * playground bundles it itself.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function read(name: string): string {
  return readFileSync(resolve(HERE, name), 'utf8');
}

export const HELLO_WORLD_APP = read('hello-world.app.tsx');
export const HELLO_WORLD_RULES = read('hello-world.rules');
