/**
 * `@pyric/live`'s main entry loads in a project without `vite`, which it
 * declares as an optional peer (#2081). A real Node process imports the
 * built entry under a resolve hook that refuses `vite` and every module
 * under it, so build `@pyric/cli` and `@pyric/live` first.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

const ENTRY = new URL('../dist/index.js', import.meta.url).href;

const HOOKS = `
import Module from 'node:module';
Module.registerHooks({
  resolve(specifier, context, next) {
    if (/^vite(\\/|$)/.test(specifier)) throw new Error('vite was imported: ' + specifier + ' from ' + context.parentURL);
    return next(specifier, context);
  },
});
`;

const IMPORT_ENTRY = `
const m = await import(${JSON.stringify(ENTRY)});
if (typeof m.liveFirebaseEntries !== 'function') throw new Error('no liveFirebaseEntries');
if (m.liveFirebaseEntries().size === 0) throw new Error('empty swap table');
`;

describe('@pyric/live without vite', () => {
  test('the main entry loads and builds its swap table without importing vite', () => {
    const node = process.env.PYRIC_TEST_NODE ?? 'node';
    const run = spawnSync(node, ['--import', `data:text/javascript,${encodeURIComponent(HOOKS)}`, '--input-type=module', '-e', IMPORT_ENTRY], {
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });
});
