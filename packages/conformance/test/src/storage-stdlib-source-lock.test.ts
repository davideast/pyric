import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFunctions, parseToAST } from 'pyric/rules/internal';
import { scenario as firestoreCommonScenario } from '../../rules-corpus/firestore/common-auth-membership-firestore.ts';
import { scenario as commonScenario } from '../../rules-corpus/storage/common-auth-membership.ts';
import { scenario } from '../../rules-corpus/storage/stdlib-storage-modules.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STDLIB = join(HERE, '..', '..', '..', 'pyric', 'src', 'rules', 'modules', 'stdlib');
const STORAGE_STDLIB = join(STDLIB, 'storage');
const LOCKS = join(HERE, '..', '..', 'probe-source-locks');
const OBSERVATIONS = join(HERE, '..', '..', 'observations');
const REPLAYS = join(HERE, '..', '..', '..', 'pyric', 'test', 'rules', 'modules', 'fixtures');
const MODULES = ['uploads', 'metadata', 'objects', 'time'] as const;

function comparable(functions: ReturnType<typeof parseFunctions>) {
  if (!functions) throw new Error('Storage stdlib source failed to parse');
  return functions.map(({ name, parameters, lets, body }) => ({ name, parameters, lets, body }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function assertCapturedAstLock(observation: string, functions: ReturnType<typeof parseFunctions>) {
  const lock = JSON.parse(readFileSync(join(LOCKS, `${observation}.json`), 'utf8')) as {
    basis: string;
    observation: string;
    scope: string;
    sha256: string;
  };
  const sha256 = createHash('sha256').update(JSON.stringify(comparable(functions))).digest('hex');
  expect(lock).toEqual({
    observation,
    scope: 'normalized-function-ast',
    sha256,
    basis: 'reviewed-reconstruction-from-historical-capture-code',
  });
}

describe('production-probed Storage stdlib source lock', () => {
  test('the captured 13 bodies are AST-identical to the shipped functions of the same names', () => {
    const shipped = MODULES.flatMap((moduleName) => {
      const source = readFileSync(join(STORAGE_STDLIB, `${moduleName}.rules`), 'utf8');
      return parseFunctions(source) ?? [];
    });
    const capturedRules = parseToAST(scenario.rules);
    if (!capturedRules) throw new Error('Captured Storage stdlib corpus failed to parse');
    const captured = capturedRules.service.match.functions;
    const capturedNames = new Set(captured.map(({ name }) => name));

    expect(captured).toHaveLength(13);
    expect(comparable(shipped.filter(({ name }) => capturedNames.has(name)))).toEqual(comparable(captured));
    assertCapturedAstLock('rules-storage-stdlib-storage-modules', captured);
  });

  test('every shipped function the batch did not capture has a production replay of its module', () => {
    const replays = new Set(readdirSync(REPLAYS)
      .filter((name) => /^stdlib-replay-storage-[\w-]+\.json$/.test(name))
      .map((name) => (JSON.parse(readFileSync(join(REPLAYS, name), 'utf8')) as { module: string }).module));
    const capturedRules = parseToAST(scenario.rules);
    if (!capturedRules) throw new Error('Captured Storage stdlib corpus failed to parse');
    const capturedNames = new Set(capturedRules.service.match.functions.map(({ name }) => name));
    for (const moduleName of MODULES) {
      const source = readFileSync(join(STORAGE_STDLIB, `${moduleName}.rules`), 'utf8');
      const uncaptured = (parseFunctions(source) ?? [])
        .filter(({ name }) => !capturedNames.has(name) && new RegExp(`^export function ${name}\\b`, 'm').test(source));
      if (uncaptured.length > 0) expect([moduleName, replays.has(`storage/${moduleName}`)]).toEqual([moduleName, true]);
    }
  });

  test('the captured six common bodies are AST-identical to auth and membership', () => {
    const shipped = ['auth', 'membership'].flatMap((moduleName) => {
      const source = readFileSync(join(STDLIB, `${moduleName}.rules`), 'utf8');
      return parseFunctions(source) ?? [];
    });
    const capturedRules = parseToAST(commonScenario.rules);
    if (!capturedRules) throw new Error('Captured common Storage stdlib corpus failed to parse');
    const captured = capturedRules.service.match.functions;
    const firestoreRules = parseToAST(firestoreCommonScenario.rules);
    if (!firestoreRules) throw new Error('Captured common Firestore stdlib corpus failed to parse');
    const firestoreCaptured = firestoreRules.service.match.functions;

    expect(shipped).toHaveLength(6);
    expect(captured).toHaveLength(6);
    expect(firestoreCaptured).toHaveLength(6);
    expect(comparable(shipped)).toEqual(comparable(captured));
    expect(comparable(firestoreCaptured)).toEqual(comparable(captured));
    assertCapturedAstLock('rules-storage-common-auth-membership', captured);
  });

  test('common-module metadata names the exact paired oracle rows', () => {
    for (const moduleName of ['auth', 'membership']) {
      const source = readFileSync(join(STDLIB, `${moduleName}.rules`), 'utf8');
      expect(source).toContain(
        '// @pyric-evidence storage-rules#125,firestore-rules#189',
      );
    }

    const storage = JSON.parse(readFileSync(
      join(OBSERVATIONS, 'storage-rules', 'rules-storage-common-auth-membership.json'),
      'utf8',
    )) as { name: string; rowIds: string[] };
    const firestore = JSON.parse(readFileSync(
      join(OBSERVATIONS, 'firestore-rules', 'rules-firestore-common-auth-membership-firestore.json'),
      'utf8',
    )) as { name: string; rowIds: string[] };

    expect(storage).toMatchObject({
      name: 'rules-storage-common-auth-membership',
      rowIds: ['storage-rules#125'],
    });
    expect(firestore).toMatchObject({
      name: 'rules-firestore-common-auth-membership-firestore',
      rowIds: ['firestore-rules#189'],
    });
  });
});
