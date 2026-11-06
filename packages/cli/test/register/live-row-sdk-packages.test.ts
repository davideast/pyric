/**
 * The `@firebase/*` packages the live register lets the live rows load
 * (`LIVE_ROW_SDK_PACKAGES` in `swap-or-stop.ts`) are derived again here, from
 * the installed SDK: a plain Node process imports `firebase/app`,
 * `firebase/auth`, `firebase/firestore`, `firebase/app-check`,
 * `firebase/database`, `firebase/ai` and `firebase/storage` as a live row does (an ESM import,
 * Node's conditions), and records every file Node resolves. A Firebase SDK in the
 * supported range that loads one more package fails this test, instead of
 * stopping the app at run time.
 *
 * Runs under the `node` on PATH; run it under Node 22.15 and Node 24.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { LIVE_ROW_SDK_PACKAGES, isFirebaseSdkName } from '../../src/register/swap-or-stop.js';
import { packageNameOf } from '../../src/register/package-identity.js';

const repoRoot = resolve(import.meta.dir, '../../../..');
const requireFromRepo = createRequire(join(repoRoot, 'package.json'));
const firebaseDir = realpathSync(dirname(requireFromRepo.resolve('firebase/package.json')));

const LIVE_ROWS = ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/app-check', 'firebase/database', 'firebase/ai', 'firebase/storage'];

/** Imports the live rows' entries from the installed firebase and prints every URL Node resolved. */
const PROBE = `import Module from 'node:module';
const resolved = new Set();
Module.registerHooks({ resolve(specifier, context, nextResolve) { const result = nextResolve(specifier, context); resolved.add(result.url); return result; } });
for (const specifier of ${JSON.stringify(LIVE_ROWS)}) await import(specifier);
console.log('RESOLVED ' + JSON.stringify([...resolved]));
`;

function resolvedUrls(): string[] {
  const result = spawnSync('node', ['--input-type=module', '-e', PROBE], {
    cwd: firebaseDir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: firebaseDir },
  });
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('RESOLVED '));
  if (line === undefined) throw new Error(`the probe printed nothing (status ${result.status}):\n${result.stderr}`);
  return JSON.parse(line.slice('RESOLVED '.length)) as string[];
}

describe('the packages the live rows load', () => {
  it('are exactly LIVE_ROW_SDK_PACKAGES, besides firebase itself, for the installed SDK', () => {
    const names = new Set<string>();
    for (const url of resolvedUrls()) {
      const isFile = url.startsWith('file:');
      if (!isFile) continue;
      const name = packageNameOf(url);
      if (isFirebaseSdkName(name)) names.add(name as string);
    }
    expect(names.has('firebase')).toBe(true);
    names.delete('firebase');
    expect([...names].sort()).toEqual([...LIVE_ROW_SDK_PACKAGES].sort());
  }, 60_000);
});
