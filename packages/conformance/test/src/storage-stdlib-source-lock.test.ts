import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFunctions, parseToAST } from 'pyric/rules/internal';
import { scenario as commonScenario } from '../../rules-corpus/storage/common-auth-membership.ts';
import { scenario } from '../../rules-corpus/storage/stdlib-storage-modules.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STDLIB = join(HERE, '..', '..', '..', 'pyric', 'src', 'rules', 'modules', 'stdlib');
const STORAGE_STDLIB = join(STDLIB, 'storage');
const LOCKS = join(HERE, '..', '..', 'probe-source-locks');
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
  test('the captured 13 bodies are AST-identical to the four shipped modules', () => {
    const shipped = MODULES.flatMap((moduleName) => {
      const source = readFileSync(join(STORAGE_STDLIB, `${moduleName}.rules`), 'utf8');
      return parseFunctions(source) ?? [];
    });
    const capturedRules = parseToAST(scenario.rules);
    if (!capturedRules) throw new Error('Captured Storage stdlib corpus failed to parse');
    const captured = capturedRules.service.match.functions;

    expect(shipped).toHaveLength(13);
    expect(captured).toHaveLength(13);
    expect(comparable(shipped)).toEqual(comparable(captured));
    assertCapturedAstLock('rules-storage-stdlib-storage-modules', captured);
  });

  test('the captured six common bodies are AST-identical to auth and membership', () => {
    const shipped = ['auth', 'membership'].flatMap((moduleName) => {
      const source = readFileSync(join(STDLIB, `${moduleName}.rules`), 'utf8');
      return parseFunctions(source) ?? [];
    });
    const capturedRules = parseToAST(commonScenario.rules);
    if (!capturedRules) throw new Error('Captured common Storage stdlib corpus failed to parse');
    const captured = capturedRules.service.match.functions;

    expect(shipped).toHaveLength(6);
    expect(captured).toHaveLength(6);
    expect(comparable(shipped)).toEqual(comparable(captured));
    assertCapturedAstLock('rules-storage-common-auth-membership', captured);
  });
});
