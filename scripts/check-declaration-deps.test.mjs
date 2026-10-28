import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { undeclaredDeclarationImports } from './lib/check-declaration-deps.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function packageDir(manifest, files) {
  const dir = mkdtempSync(join(tmpdir(), 'declaration-deps-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  for (const [path, source] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, source);
  }
  return dir;
}

describe('published declaration imports', () => {
  test('accepts imports of dependencies, peer dependencies, the package itself, builtins and relative files', () => {
    const dir = packageDir(
      {
        name: '@scope/pkg',
        dependencies: { zod: '^3.0.0' },
        peerDependencies: { '@peer/lib': '*' },
      },
      {
        'dist/index.d.ts': [
          "import type { ZodType } from 'zod';",
          "import type { Peer } from '@peer/lib/sub';",
          "export type { Self } from '@scope/pkg/internal';",
          "import type { Server } from 'node:http';",
          "import type { Stats } from 'fs';",
          "export * from './other.js';",
          '/// <reference types="node" />',
          "export type Lazy = import('zod').ZodType;",
          "declare module '*.css' { const css: string; export default css; }",
        ].join('\n'),
        'dist/other.d.ts': 'export declare const x: number;\n',
      },
    );
    expect(undeclaredDeclarationImports(dir)).toEqual([]);
  });

  test('reports a type import of a package that is only a dev dependency', () => {
    const dir = packageDir(
      { name: 'pkg', dependencies: {}, devDependencies: { '@agent/runtime': '1.0.0' } },
      { 'dist/tools.d.ts': "import type { ToolHandler } from '@agent/runtime';\n" },
    );
    expect(undeclaredDeclarationImports(dir)).toEqual(['dist/tools.d.ts -> @agent/runtime']);
  });

  test('reports re-exports, import() types and reference directives of undeclared packages', () => {
    const dir = packageDir(
      { name: 'pkg' },
      {
        'dist/a.d.ts': "export { X } from 'missing-a';\n",
        'dist/nested/b.d.ts': "export type Y = import('missing-b/deep').Y;\n",
        'dist/c.d.ts': '/// <reference types="missing-c" />\n',
        'dist/d.js': "import 'ignored-in-js';\n",
      },
    );
    expect(undeclaredDeclarationImports(dir)).toEqual([
      'dist/a.d.ts -> missing-a',
      'dist/c.d.ts -> missing-c',
      'dist/nested/b.d.ts -> missing-b/deep',
    ]);
  });

  test('skips node_modules inside the package directory', () => {
    const dir = packageDir(
      { name: 'pkg' },
      { 'node_modules/dep/index.d.ts': "import 'not-ours';\n" },
    );
    expect(undeclaredDeclarationImports(dir)).toEqual([]);
  });
});
