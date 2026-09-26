/**
 * One multi-file rules project, resolved by every path that resolves rules:
 * the resolver API, the `pyric firestore rules resolve` command, and the dev
 * server's loader. All three must produce the same rules, and the rules must
 * evaluate. The project is laid out the way a rules author splits rules:
 * the main file imports a game module, which imports the stdlib and a
 * sibling file.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firestoreRules, serverTimestamp, type FirestoreCase } from 'pyric/rules';
import { resolveModules } from 'pyric/rules/internal/node';
import { loadProjectRules, prepareRulesSource, prepareStorageRulesSource } from '../../src/serve/rules.js';

const PACKAGE_ROOT = join(import.meta.dir, '..', '..');
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');
const PROJECT = join(import.meta.dir, '..', 'fixtures', 'rules-project');
const MAIN = join(PROJECT, 'firestore.modules.rules');
const MODULE_FILES = [join(PROJECT, 'games', 'tictactoe.rules'), join(PROJECT, 'games', 'shared.rules')];

/** The resolved rules without the trailing source-map comment, which names file paths. */
function rulesOnly(resolved: string): string {
  return resolved.replace(/\/\/ @pyric-source-map: .*\n?$/, '');
}

function referenceRules(): string {
  const result = resolveModules(readFileSync(MAIN, 'utf8'), { basePath: PROJECT });
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return rulesOnly(result.data.resolved);
}

describe('a multi-file rules project', () => {
  test('the resolver API inlines the module, its stdlib imports and its sibling file', () => {
    const rules = referenceRules();
    for (const fn of ['ticTacToeCreate', 'validCreate', 'isMyTurn', 'moveIncremented', 'signedIn']) {
      expect(rules).toContain(`function ${fn}(`);
    }
  });

  test('`pyric firestore rules resolve` writes the same rules', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'pyric-rules-project-')), 'firestore.rules');
    const run = spawnSync('bun', [CLI_ENTRY, 'firestore', 'rules', 'resolve', MAIN, '--out', out], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.stderr).not.toContain('Failed');
    expect(run.status).toBe(0);
    expect(rulesOnly(readFileSync(out, 'utf8'))).toBe(referenceRules());
  });

  test('the dev server prepares the same rules', () => {
    expect(rulesOnly(prepareRulesSource(readFileSync(MAIN, 'utf8'), MAIN))).toBe(referenceRules());
  });

  test('the dev server loads the project and reports the module files it read', async () => {
    const loaded = await loadProjectRules(PROJECT, { firestore: { rules: 'firestore.modules.rules' } });
    expect(rulesOnly(loaded.rules ?? '')).toBe(referenceRules());
    expect(loaded.sourcePath).toBe(MAIN);
    expect(loaded.moduleFiles).toEqual(MODULE_FILES);
  });

  test('the resolved rules evaluate', () => {
    const empty = Object.fromEntries(
      ['c0r0', 'c1r0', 'c2r0', 'c0r1', 'c1r1', 'c2r1', 'c0r2', 'c1r2', 'c2r2'].map((c) => [c, '']),
    );
    const waiting = { host: 'alice', guest: '', status: 'waiting', currentTurn: 'host', moveCount: 0, board: empty };
    const playing = { ...waiting, guest: 'bob', status: 'playing' };
    const moved = { ...playing, currentTurn: 'guest', moveCount: 1 };
    const cases: FirestoreCase[] = [
      { description: 'the host creates an empty match', expectation: 'ALLOW', method: 'create', path: 'tictactoe/m', auth: { uid: 'alice' }, data: waiting },
      { description: 'a match created with a mark on the board', expectation: 'DENY', method: 'create', path: 'tictactoe/m', auth: { uid: 'alice' }, data: { ...waiting, board: { ...empty, c0r0: 'host' } } },
      { description: 'the guest joins', expectation: 'ALLOW', method: 'update', path: 'tictactoe/m', auth: { uid: 'bob' }, resource: waiting, data: playing },
      { description: 'the player on turn moves', expectation: 'ALLOW', method: 'update', path: 'tictactoe/m', auth: { uid: 'alice' }, resource: playing, data: moved },
      { description: 'the player not on turn moves', expectation: 'DENY', method: 'update', path: 'tictactoe/m', auth: { uid: 'bob' }, resource: playing, data: moved },
      { description: 'a signed-out move', expectation: 'DENY', method: 'update', path: 'tictactoe/m', auth: null, resource: playing, data: moved },
    ];
    const summary = firestoreRules(referenceRules()).simulate(cases);
    expect(summary.cases.filter((c) => !c.passed).map((c) => c.description)).toEqual([]);
    expect(serverTimestamp).toBeDefined();
  });

  test('the dev server resolves a relative import in modular Storage rules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-storage-project-'));
    mkdirSync(join(dir, 'rules'));
    writeFileSync(join(dir, 'rules', 'uploads.rules'), "rules_version = '2+modules';\nimport { sizeAtMost } from 'storage/uploads';\nexport function smallUpload() { return sizeAtMost(1024); }\n");
    const main = join(dir, 'storage.modules.rules');
    writeFileSync(main, "rules_version = '2+modules';\nimport { smallUpload } from './rules/uploads';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{path=**} { allow write: if smallUpload(); }\n  }\n}\n");
    const rules = prepareStorageRulesSource(readFileSync(main, 'utf8'), main);
    expect(rules).toContain('function smallUpload(');
    expect(rules).toContain('function sizeAtMost(');
  });
});
