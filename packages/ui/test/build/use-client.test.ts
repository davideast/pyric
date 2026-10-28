import { describe, it, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  entriesMissingUseClient,
  exportedEntries,
  startsWithUseClient,
} from '../../scripts/check-use-client.js';

const packageDir = join(import.meta.dir, '..', '..');
const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

describe('use client directive', () => {
  it('accepts the directive as the first statement, after comments', () => {
    expect(startsWithUseClient(`'use client';\nexport {};`)).toBe(true);
    expect(startsWithUseClient(`"use client"\nexport {};`)).toBe(true);
    expect(startsWithUseClient(`/** doc */\n// note\n'use client';\nexport {};`)).toBe(true);
  });

  it('rejects a directive that is not the first statement', () => {
    expect(startsWithUseClient(`export {};\n'use client';`)).toBe(false);
    expect(startsWithUseClient(`const a = 1;`)).toBe(false);
    expect(startsWithUseClient(`'use strict';\n'use client';`)).toBe(false);
  });

  it('starts every source file behind a subpath entry with the directive', () => {
    const sources = exportedEntries(packageJson).map((entry) =>
      join(packageDir, entry.replace('./dist/', 'src/').replace(/\.js$/, '.ts')),
    );
    expect(sources.length).toBe(Object.keys(packageJson.exports).length);
    const missing = sources.filter((file) => !startsWithUseClient(readFileSync(file, 'utf8')));
    expect(missing).toEqual([]);
  });

  it('reports built entries that lack the directive or are absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'use-client-'));
    try {
      mkdirSync(join(dir, 'dist'));
      writeFileSync(join(dir, 'dist', 'ok.js'), `'use client';\nexport {};\n`);
      writeFileSync(join(dir, 'dist', 'bad.js'), `export {};\n`);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        exports: {
          './ok': { import: './dist/ok.js' },
          './bad': { import: './dist/bad.js' },
          './gone': { import: './dist/gone.js' },
        },
      }));
      expect(entriesMissingUseClient(dir)).toEqual(['./dist/bad.js', './dist/gone.js']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
