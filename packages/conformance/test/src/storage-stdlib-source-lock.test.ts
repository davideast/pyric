import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFunctions, parseToAST } from 'pyric/rules/internal';
import { scenario } from '../../rules-corpus/storage/stdlib-storage-modules.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STDLIB = join(HERE, '..', '..', '..', 'pyric', 'src', 'rules', 'modules', 'stdlib', 'storage');
const MODULES = ['uploads', 'metadata', 'objects', 'time'] as const;

function comparable(functions: ReturnType<typeof parseFunctions>) {
  if (!functions) throw new Error('Storage stdlib source failed to parse');
  return functions.map(({ name, parameters, lets, body }) => ({ name, parameters, lets, body }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

describe('production-probed Storage stdlib source lock', () => {
  test('the captured 13 bodies are AST-identical to the four shipped modules', () => {
    const shipped = MODULES.flatMap((moduleName) => {
      const source = readFileSync(join(STDLIB, `${moduleName}.rules`), 'utf8');
      return parseFunctions(source) ?? [];
    });
    const capturedRules = parseToAST(scenario.rules);
    if (!capturedRules) throw new Error('Captured Storage stdlib corpus failed to parse');
    const captured = capturedRules.service.match.functions;

    expect(shipped).toHaveLength(13);
    expect(captured).toHaveLength(13);
    expect(comparable(shipped)).toEqual(comparable(captured));
  });
});
