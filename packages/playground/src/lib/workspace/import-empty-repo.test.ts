import { describe, expect, test } from 'bun:test';
import { isScaffoldableEmptyRepo } from './import-from-github';

const P = (...names: string[]) => names.map((n) => `/workspace/${n}`);

describe('isScaffoldableEmptyRepo', () => {
  test('README-only repo is scaffoldable (the reported case)', () => {
    expect(isScaffoldableEmptyRepo(P('README.md'))).toBe(true);
  });

  test('docs + dotfiles only → scaffoldable', () => {
    expect(
      isScaffoldableEmptyRepo(P('README.md', 'LICENSE', '.gitignore', 'docs/guide.md')),
    ).toBe(true);
  });

  test('ignores .git internals', () => {
    expect(isScaffoldableEmptyRepo(P('README.md', '.git/HEAD', '.git/config'))).toBe(true);
  });

  test('a firestore.rules means there IS content to import', () => {
    expect(isScaffoldableEmptyRepo(P('firestore.rules'))).toBe(false);
  });

  test('a package.json means a real project', () => {
    expect(isScaffoldableEmptyRepo(P('README.md', 'package.json'))).toBe(false);
  });

  test('any source file means not scaffoldable', () => {
    expect(isScaffoldableEmptyRepo(P('src/App.tsx'))).toBe(false);
    expect(isScaffoldableEmptyRepo(P('index.js'))).toBe(false);
    expect(isScaffoldableEmptyRepo(P('src/main.jsx'))).toBe(false);
  });

  test('completely empty repo → scaffoldable', () => {
    expect(isScaffoldableEmptyRepo([])).toBe(true);
  });
});
