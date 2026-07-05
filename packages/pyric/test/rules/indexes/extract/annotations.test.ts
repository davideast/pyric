/**
 * Unit tests for the @firestore-* annotation parser.
 */
import { describe, test, expect } from 'bun:test';
import { parseAnnotations } from '../../../../src/rules/indexes/extract/annotations.js';

describe('parseAnnotations — empty / fallback', () => {
  test('empty string → empty annotations, no warnings', () => {
    const r = parseAnnotations('');
    expect(r.annotations.mutexGroups).toHaveLength(0);
    expect(r.annotations.required.size).toBe(0);
    expect(r.annotations.budget).toBeUndefined();
    expect(r.warnings).toHaveLength(0);
  });

  test('comment with no firestore tags → empty + no warnings (additive fallback)', () => {
    const r = parseAnnotations(`/**
     * Just a regular function comment.
     * @param x The first thing.
     * @returns A query.
     */`);
    expect(r.annotations.mutexGroups).toHaveLength(0);
    expect(r.annotations.required.size).toBe(0);
    expect(r.warnings).toHaveLength(0);
  });
});

describe('parseAnnotations — @firestore-mutex', () => {
  test('single mutex group', () => {
    const r = parseAnnotations('/** @firestore-mutex { category, city, price } */');
    expect(r.annotations.mutexGroups).toHaveLength(1);
    expect([...r.annotations.mutexGroups[0]]).toEqual(['category', 'city', 'price']);
    expect(r.warnings).toHaveLength(0);
  });

  test('multiple mutex groups → independent groups', () => {
    const r = parseAnnotations(`/**
     * @firestore-mutex { country, region }
     * @firestore-mutex { plan, tier }
     */`);
    expect(r.annotations.mutexGroups).toHaveLength(2);
    expect([...r.annotations.mutexGroups[0]]).toEqual(['country', 'region']);
    expect([...r.annotations.mutexGroups[1]]).toEqual(['plan', 'tier']);
  });

  test('extra whitespace tolerated', () => {
    const r = parseAnnotations('/** @firestore-mutex {   a ,b ,  c   } */');
    expect([...r.annotations.mutexGroups[0]]).toEqual(['a', 'b', 'c']);
  });

  test('empty braces → malformed-mutex warning', () => {
    const r = parseAnnotations('/** @firestore-mutex { } */');
    expect(r.annotations.mutexGroups).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].code).toBe('malformed-mutex');
  });

  test('no braces at all → malformed-mutex warning', () => {
    const r = parseAnnotations('/** @firestore-mutex category, city */');
    expect(r.annotations.mutexGroups).toHaveLength(0);
    expect(r.warnings.some(w => w.code === 'malformed-mutex')).toBe(true);
  });
});

describe('parseAnnotations — @firestore-required', () => {
  test('single required field', () => {
    const r = parseAnnotations('/** @firestore-required tenantId */');
    expect([...r.annotations.required]).toEqual(['tenantId']);
    expect(r.warnings).toHaveLength(0);
  });

  test('multiple required fields, comma-separated', () => {
    const r = parseAnnotations('/** @firestore-required tenantId, ownerId */');
    expect([...r.annotations.required].sort()).toEqual(['ownerId', 'tenantId']);
  });

  test('multiple required tags accumulate', () => {
    const r = parseAnnotations(`/**
     * @firestore-required tenantId
     * @firestore-required ownerId
     */`);
    expect([...r.annotations.required].sort()).toEqual(['ownerId', 'tenantId']);
  });

  test('empty required list → malformed-required warning', () => {
    const r = parseAnnotations('/** @firestore-required */');
    expect(r.annotations.required.size).toBe(0);
    expect(r.warnings.some(w => w.code === 'malformed-required')).toBe(true);
  });

  test('does not bleed into next @-tag on the same line', () => {
    const r = parseAnnotations('/** @firestore-required a, b @firestore-budget 5 */');
    expect([...r.annotations.required].sort()).toEqual(['a', 'b']);
    expect(r.annotations.budget).toBe(5);
  });
});

describe('parseAnnotations — @firestore-budget', () => {
  test('positive integer', () => {
    const r = parseAnnotations('/** @firestore-budget 12 */');
    expect(r.annotations.budget).toBe(12);
    expect(r.warnings).toHaveLength(0);
  });

  test('multiple budgets → tightest wins', () => {
    const r = parseAnnotations(`/**
     * @firestore-budget 20
     * @firestore-budget 12
     */`);
    expect(r.annotations.budget).toBe(12);
  });

  test('zero → malformed-budget warning', () => {
    const r = parseAnnotations('/** @firestore-budget 0 */');
    expect(r.annotations.budget).toBeUndefined();
    expect(r.warnings.some(w => w.code === 'malformed-budget')).toBe(true);
  });

  test('non-numeric → malformed-budget warning', () => {
    const r = parseAnnotations('/** @firestore-budget twelve */');
    expect(r.annotations.budget).toBeUndefined();
    expect(r.warnings.some(w => w.code === 'malformed-budget')).toBe(true);
  });

  test('missing value → malformed-budget warning', () => {
    const r = parseAnnotations('/** @firestore-budget */');
    expect(r.annotations.budget).toBeUndefined();
    expect(r.warnings.some(w => w.code === 'malformed-budget')).toBe(true);
  });

  test('negative number → malformed-budget warning', () => {
    const r = parseAnnotations('/** @firestore-budget -3 */');
    expect(r.annotations.budget).toBeUndefined();
    expect(r.warnings.some(w => w.code === 'malformed-budget')).toBe(true);
  });
});

describe('parseAnnotations — unknown @firestore-* tags', () => {
  test('typo on a known tag → unknown-firestore-tag warning', () => {
    const r = parseAnnotations('/** @firestore-mutext { a, b } */');
    expect(r.warnings.some(w => w.code === 'unknown-firestore-tag' && w.tag === 'firestore-mutext')).toBe(true);
  });

  test('completely unknown tag → unknown-firestore-tag warning', () => {
    const r = parseAnnotations('/** @firestore-pinky promise */');
    expect(r.warnings.some(w => w.code === 'unknown-firestore-tag' && w.tag === 'firestore-pinky')).toBe(true);
  });

  test('one warning per unique unknown tag, even if repeated', () => {
    const r = parseAnnotations(`/**
     * @firestore-foo bar
     * @firestore-foo baz
     */`);
    const unknownFoo = r.warnings.filter(w => w.code === 'unknown-firestore-tag' && w.tag === 'firestore-foo');
    expect(unknownFoo).toHaveLength(1);
  });

  test('non-firestore @-tags are ignored (no false-positive warning)', () => {
    const r = parseAnnotations(`/**
     * @param x The thing.
     * @returns The result.
     * @deprecated
     */`);
    expect(r.warnings).toHaveLength(0);
  });
});

describe('parseAnnotations — combined', () => {
  test('mutex + required + budget all in one comment', () => {
    const r = parseAnnotations(`/**
     * Apply UI filters to the restaurants query.
     * @firestore-mutex { category, city, price }
     * @firestore-required tenantId
     * @firestore-budget 12
     */`);
    expect(r.annotations.mutexGroups).toHaveLength(1);
    expect([...r.annotations.mutexGroups[0]]).toEqual(['category', 'city', 'price']);
    expect([...r.annotations.required]).toEqual(['tenantId']);
    expect(r.annotations.budget).toBe(12);
    expect(r.warnings).toHaveLength(0);
  });

  test('valid annotations alongside one malformed → valid still parsed', () => {
    const r = parseAnnotations(`/**
     * @firestore-mutex { a, b }
     * @firestore-budget oops
     */`);
    expect(r.annotations.mutexGroups).toHaveLength(1);
    expect(r.annotations.budget).toBeUndefined();
    expect(r.warnings.some(w => w.code === 'malformed-budget')).toBe(true);
  });
});
