import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('conformance package typecheck coverage', () => {
  it('includes every production source file instead of a hand-picked subset', () => {
    const config = JSON.parse(readFileSync(new URL('../../tsconfig.json', import.meta.url), 'utf8')) as {
      include?: string[];
      exclude?: string[];
    };
    expect(config.include).toEqual(['**/*.ts']);
    expect(config.exclude).toEqual(['node_modules']);
  });
});
