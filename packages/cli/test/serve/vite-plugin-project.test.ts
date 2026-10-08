/**
 * The Vite plugin's Firebase project, end to end through `/__pyric/init.json`:
 * a `firebase.json` `database` array of deploy targets that `.firebaserc`
 * maps per project, served with `functions: false`.
 *
 * `XDG_CONFIG_HOME` points at an empty temporary directory, so the
 * developer's own `firebase use` state is never read.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootPlugin, initJson, warmViteWorkerBundle } from './vite-plugin-harness.js';

beforeAll(async () => { await warmViteWorkerBundle(); }, 180_000);

const MAIN_RULES = { rules: { '.read': true, '.write': true } };
const saved = { PYRIC_PROJECT: process.env.PYRIC_PROJECT, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
const configHome = mkdtempSync(join(tmpdir(), 'pyric-vite-project-config-'));
const roots: string[] = [];

beforeAll(() => {
  delete process.env.PYRIC_PROJECT;
  process.env.XDG_CONFIG_HOME = configHome;
});

afterEach(() => {
  delete process.env.PYRIC_PROJECT;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(configHome, { recursive: true, force: true });
});

function targetsProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'pyric-vite-project-'));
  roots.push(root);
  writeFileSync(join(root, 'firebase.json'), JSON.stringify({ database: [{ target: 'main', rules: 'main.rules.json' }] }));
  writeFileSync(join(root, 'main.rules.json'), JSON.stringify(MAIN_RULES));
  writeFileSync(join(root, '.firebaserc'), JSON.stringify({
    projects: { staging: 'p' },
    targets: { p: { database: { main: ['main-a'] } }, q: { database: { main: ['q-main'] } } },
  }));
  return root;
}

describe('pyric() project resolution', () => {
  it('maps deploy targets through PYRIC_PROJECT with functions off', async () => {
    const root = targetsProject();
    process.env.PYRIC_PROJECT = 'q';
    const init = await initJson(await bootPlugin({ functions: false, ui: false }, root));
    expect(init.databaseInstances).toEqual({ defaultInstance: 'q-default-rtdb', rules: { 'q-main': MAIN_RULES } });
  });

  it('maps deploy targets through the project option, resolving a .firebaserc alias', async () => {
    const root = targetsProject();
    process.env.PYRIC_PROJECT = 'q';
    const init = await initJson(await bootPlugin({ functions: false, ui: false, project: 'staging' }, root));
    expect(init.databaseInstances).toEqual({ defaultInstance: 'p-default-rtdb', rules: { 'main-a': MAIN_RULES } });
  });

  it('starts without a resolvable project and carries the target for the app config to resolve', async () => {
    const root = targetsProject();
    writeFileSync(join(root, '.firebaserc'), JSON.stringify({
      targets: { p: { database: { main: ['main-a'] } } },
    }));
    const init = await initJson(await bootPlugin({ functions: false, ui: false }, root));
    expect(init.databaseInstances).toEqual({
      defaultInstance: '(default)',
      rules: {},
      pendingTargets: [{ target: 'main', rules: MAIN_RULES, instancesByProject: { p: ['main-a'] } }],
    });
  });
});
