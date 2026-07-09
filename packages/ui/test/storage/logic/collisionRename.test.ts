// The OS-copy collision rule, pinned precisely (spec: mirror macOS
// Finder counter semantics with the ` (n)` spelling — increment an
// existing counter, never nest one).
import { describe, it, expect } from 'bun:test';
import {
  splitStorageName,
  parseCopyCounter,
  resolveCollision,
  planBatchNames,
} from '../../../src/storage/collisionRename.js';

const taken = (...names: string[]) => new Set(names);

describe('splitStorageName (extension rule)', () => {
  it('splits at the last dot', () => {
    expect(splitStorageName('photo.png')).toEqual({ stem: 'photo', ext: '.png' });
    expect(splitStorageName('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' });
  });
  it('dotfiles have no extension — the whole name is the stem', () => {
    expect(splitStorageName('.gitignore')).toEqual({ stem: '.gitignore', ext: '' });
    expect(splitStorageName('.env')).toEqual({ stem: '.env', ext: '' });
  });
  it('extensionless and trailing-dot names have no extension', () => {
    expect(splitStorageName('Makefile')).toEqual({ stem: 'Makefile', ext: '' });
    expect(splitStorageName('notes.')).toEqual({ stem: 'notes.', ext: '' });
  });
});

describe('parseCopyCounter', () => {
  it('reads a trailing " (n)"', () => {
    expect(parseCopyCounter('photo (3)')).toEqual({ base: 'photo', counter: 3 });
  });
  it('only the FINAL counter parses — earlier ones are part of the base', () => {
    expect(parseCopyCounter('photo (1) (2)')).toEqual({ base: 'photo (1)', counter: 2 });
  });
  it('no counter → null', () => {
    expect(parseCopyCounter('photo')).toEqual({ base: 'photo', counter: null });
    // No space, or non-integer: not a counter.
    expect(parseCopyCounter('photo(1)')).toEqual({ base: 'photo(1)', counter: null });
    expect(parseCopyCounter('photo (a)')).toEqual({ base: 'photo (a)', counter: null });
  });
});

describe('resolveCollision', () => {
  it('returns a free name unchanged', () => {
    expect(resolveCollision('photo.png', taken('other.png'))).toBe('photo.png');
  });
  it('first collision → " (1)" before the extension', () => {
    expect(resolveCollision('photo.png', taken('photo.png'))).toBe('photo (1).png');
  });
  it('skips taken counters', () => {
    expect(
      resolveCollision('photo.png', taken('photo.png', 'photo (1).png', 'photo (2).png')),
    ).toBe('photo (3).png');
  });
  it('INCREMENTS an existing counter (the spec pin): "photo (1).png" → "photo (2).png"', () => {
    expect(resolveCollision('photo (1).png', taken('photo (1).png'))).toBe('photo (2).png');
    // Never nests: not "photo (1) (1).png".
  });
  it('only the final counter moves on multi-counter stems', () => {
    expect(resolveCollision('photo (1) (2).png', taken('photo (1) (2).png'))).toBe(
      'photo (1) (3).png',
    );
  });
  it('extensionless files counter at the end', () => {
    expect(resolveCollision('Makefile', taken('Makefile'))).toBe('Makefile (1)');
    expect(resolveCollision('Makefile (1)', taken('Makefile (1)'))).toBe('Makefile (2)');
  });
  it('dotfiles counter after the whole name (no extension to protect)', () => {
    expect(resolveCollision('.env', taken('.env'))).toBe('.env (1)');
    expect(resolveCollision('.env (1)', taken('.env (1)', '.env (2)'))).toBe('.env (3)');
  });
});

describe('planBatchNames (drop batches)', () => {
  it('passes a collision-free batch through unchanged', () => {
    expect(planBatchNames(['a.txt', 'photos/cat.png'], taken('b.txt'))).toEqual([
      'a.txt',
      'photos/cat.png',
    ]);
  });
  it('renames colliding top-level files individually, claiming each result', () => {
    expect(planBatchNames(['a.txt', 'a.txt'], taken('a.txt'))).toEqual([
      'a (1).txt',
      'a (2).txt',
    ]);
  });
  it('renames a colliding dropped folder ONCE at its root, contents ride along', () => {
    expect(
      planBatchNames(['photos/cat.png', 'photos/sub/dog.png'], taken('photos')),
    ).toEqual(['photos (1)/cat.png', 'photos (1)/sub/dog.png']);
  });
  it('a batch file cannot steal a name another batch entry claimed', () => {
    // The renamed folder claims "photos (1)"; a same-named file drops after.
    expect(planBatchNames(['photos/cat.png', 'photos (1)'], taken('photos'))).toEqual([
      'photos (1)/cat.png',
      'photos (2)',
    ]);
  });
  it('deep paths beyond the root are NOT collision-checked (one listAll level)', () => {
    // 'photos' itself is free, so the inner path is used as-is even if a
    // deep object exists — GCS overwrite semantics apply there.
    expect(planBatchNames(['photos/cat.png'], taken('cat.png'))).toEqual([
      'photos/cat.png',
    ]);
  });
});

describe('parseCopyCounter: unsafe-integer counters are plain text', () => {
  const huge = '99999999999999999999999'; // > MAX_SAFE_INTEGER
  it('a counter beyond MAX_SAFE_INTEGER parses as no counter', () => {
    expect(parseCopyCounter(`photo (${huge})`)).toEqual({
      base: `photo (${huge})`,
      counter: null,
    });
  });

  it('resolveCollision appends a fresh (1) instead of hanging/scientific notation', () => {
    const name = `photo (${huge}).png`;
    const resolved = resolveCollision(name, new Set([name]));
    expect(resolved).toBe(`photo (${huge}) (1).png`);
  });

  it('a counter at MAX_SAFE_INTEGER still parses (the boundary is exclusive above)', () => {
    const max = String(Number.MAX_SAFE_INTEGER);
    expect(parseCopyCounter(`photo (${max})`)).toEqual({ base: 'photo', counter: Number.MAX_SAFE_INTEGER });
  });
});
