import { describe, expect, test } from 'bun:test';
import {
  posixDirname,
  posixJoin,
  posixNormalize,
  posixRelative,
  posixResolve,
  toPosixPath,
} from '../../../src/assurance-surface/code/posix-path.js';

describe('posix-path', () => {
  test('normalizes slashes, dot segments, and parent segments', () => {
    expect(toPosixPath('src\\items\\list.ts')).toBe('src/items/list.ts');
    expect(posixNormalize('/app/src/./nested/../items//view.tsx')).toBe('/app/src/items/view.tsx');
    expect(posixNormalize('src/./a/../b/')).toBe('src/b');
    expect(posixNormalize('/')).toBe('/');
    expect(posixNormalize('')).toBe('.');
  });

  test('joins and resolves absolute and relative paths without process cwd', () => {
    expect(posixJoin('/app', 'src', 'items/index.ts')).toBe('/app/src/items/index.ts');
    expect(posixJoin('src', '../shared', 'db.ts')).toBe('shared/db.ts');
    expect(posixResolve('/app', 'web/src', '../tsconfig.json')).toBe('/app/web/tsconfig.json');
    expect(posixResolve('/app', '/other/root', 'file.ts')).toBe('/other/root/file.ts');
    expect(posixResolve('relative/app', 'src/a.ts')).toBe('/relative/app/src/a.ts');
  });

  test('computes dirname and relative paths across sibling and parent directories', () => {
    expect(posixDirname('/app/web/tsconfig.json')).toBe('/app/web');
    expect(posixDirname('/file.ts')).toBe('/');
    expect(posixRelative('/app', '/app/web/src/a.ts')).toBe('web/src/a.ts');
    expect(posixRelative('/app/web', '/app/shared/s.ts')).toBe('../shared/s.ts');
    expect(posixRelative('/app', '/app')).toBe('');
  });
});
