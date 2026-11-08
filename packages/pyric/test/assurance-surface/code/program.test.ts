import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { buildPrograms, isExcludedPath } from '../../../src/assurance-surface/code/program.js';
import { ROOT } from './harness.js';

describe('isExcludedPath', () => {
  test('skips declaration, test, harness and minified files', () => {
    expect(isExcludedPath('src/a.d.ts', [])).toBe(true);
    expect(isExcludedPath('src/a.test.tsx', [])).toBe(true);
    expect(isExcludedPath('e2e/flow.pw.ts', [])).toBe(true);
    expect(isExcludedPath('test/helpers.ts', [])).toBe(true);
    expect(isExcludedPath('vendor/lib.min.js', [])).toBe(true);
    expect(isExcludedPath('src/app.ts', [])).toBe(false);
  });

  test('applies preset excludes as substrings', () => {
    expect(isExcludedPath('scripts/seed.ts', ['scripts/'])).toBe(true);
  });
});

describe('buildPrograms', () => {
  test('one program per tsconfig with its own path aliases; loose files share a default program', () => {
    const programs = buildPrograms(ROOT, {
      'web/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } }, include: ['src'] }),
      'web/src/a.ts': `import { b } from '@/b'; export const a = b;`,
      'web/src/b.ts': `export const b = 1;`,
      'tools/c.js': `export const c = 2;`,
    }, []);
    expect(programs.map((p) => [p.config, p.files.map((f) => f.fileName.slice(ROOT.length + 1))])).toEqual([
      ['web/tsconfig.json', ['web/src/a.ts', 'web/src/b.ts']],
      ['<default>', ['tools/c.js']],
    ]);
    const web = programs[0];
    const a = web.program.getSourceFile(`${ROOT}/web/src/a.ts`)!;
    const importDecl = a.statements[0] as ts.ImportDeclaration;
    const moduleSymbol = web.checker.getSymbolAtLocation(importDecl.moduleSpecifier);
    expect(moduleSymbol?.valueDeclaration?.getSourceFile().fileName).toBe(`${ROOT}/web/src/b.ts`);
  });

  test('a file is scanned by exactly one program', () => {
    const programs = buildPrograms(ROOT, {
      'a/tsconfig.json': JSON.stringify({ include: ['.', '../shared'] }),
      'b/tsconfig.json': JSON.stringify({ include: ['.', '../shared'] }),
      'a/x.ts': `import '../shared/s';`,
      'b/y.ts': `import '../shared/s';`,
      'shared/s.ts': `export {};`,
    }, []);
    const scanned = programs.flatMap((p) => p.files.map((f) => f.fileName));
    expect(scanned.filter((f) => f.endsWith('shared/s.ts'))).toHaveLength(1);
  });
});
