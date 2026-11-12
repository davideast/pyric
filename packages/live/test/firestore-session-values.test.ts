/**
 * Unit tests for `firestore-session-values.ts`: bounded value copying,
 * path normalization, and `partial` / `deleteFields` emission for omitted
 * Firestore write sentinels.
 */
import { describe, expect, test } from 'bun:test';
import {
  FieldPath,
  arrayRemove,
  arrayUnion,
  deleteField,
  increment,
  serverTimestamp,
} from 'firebase/firestore';
import {
  isValidDocPath,
  itemBudget,
  normalizeDocPath,
  sessionDocFields,
  sessionSetDocOp,
  sessionUpdateDocOp,
  sessionWriteFields,
} from '../src/firestore-session-values.js';

describe('firestore-session-values', () => {
  test('validates and normalizes document paths', () => {
    expect(isValidDocPath('items/a')).toBe(true);
    expect(isValidDocPath('/items/a/notes/n1')).toBe(true);
    expect(isValidDocPath('items')).toBe(false);
    expect(isValidDocPath('items/__proto__')).toBe(false);
    expect(normalizeDocPath('/items/a')).toBe('items/a');
    expect(normalizeDocPath('items/a')).toBe('items/a');
  });

  test('sessionDocFields copies read payloads and rejects write sentinels', () => {
    expect(sessionDocFields({ title: 'Alpha', count: 2, nested: { ok: true } })).toEqual({
      ok: true,
      value: { title: 'Alpha', count: 2, nested: { ok: true } },
    });
    expect(sessionDocFields({ updatedAt: serverTimestamp() })).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  test('sessionWriteFields marks omitted sentinels partial and optionally deletes omitted fields', () => {
    expect(
      sessionWriteFields(
        {
          title: 'Alpha',
          updatedAt: serverTimestamp(),
          nested: { count: increment(1), removed: deleteField() },
        },
        itemBudget(),
        false,
      ),
    ).toEqual({
      ok: true,
      value: {
        data: { title: 'Alpha', nested: {} },
        deleteFields: ['nested.removed'],
        partial: true,
      },
    });

    expect(
      sessionWriteFields(
        {
          title: 'Alpha',
          members: arrayUnion('u-2'),
        },
        itemBudget(),
        true,
      ),
    ).toEqual({
      ok: true,
      value: {
        data: { title: 'Alpha' },
        deleteFields: ['members'],
        partial: true,
      },
    });
  });

  test('sessionSetDocOp emits partial flags and deleteFields for unmerged, merge, and mergeFields writes', () => {
    expect(
      sessionSetDocOp('/items/a', { title: 'Alpha', updatedAt: serverTimestamp() }, undefined),
    ).toEqual({
      ok: true,
      value: {
        kind: 'set',
        path: 'items/a',
        data: { title: 'Alpha' },
        partial: true,
      },
    });

    expect(
      sessionSetDocOp(
        'items/a',
        { title: 'Alpha', members: arrayRemove('u-2') },
        { merge: true },
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: 'set',
        path: 'items/a',
        data: { title: 'Alpha' },
        merge: true,
        deleteFields: ['members'],
        partial: true,
      },
    });

    expect(
      sessionSetDocOp(
        'items/a',
        { title: 'Alpha', stats: { hits: increment(1) }, ignored: 9 },
        { mergeFields: ['title', new FieldPath('stats', 'hits')] },
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: 'update',
        path: 'items/a',
        data: { title: 'Alpha' },
        merge: true,
        deleteFields: ['stats.hits'],
        partial: true,
      },
    });
  });

  test('preserves IEEE-754 special floats (-0, NaN, +-Infinity) and escapes colliding plain maps', () => {
    const copied = sessionDocFields({
      negZero: -0,
      nanVal: Number.NaN,
      posInf: Number.POSITIVE_INFINITY,
      negInf: Number.NEGATIVE_INFINITY,
      collidingNumMap: { type: 'pyric/number/1.0', value: '-0' },
    });
    expect(copied).toEqual({
      ok: true,
      value: {
        negZero: { type: 'pyric/number/1.0', value: '-0' },
        nanVal: { type: 'pyric/number/1.0', value: 'NaN' },
        posInf: { type: 'pyric/number/1.0', value: 'Infinity' },
        negInf: { type: 'pyric/number/1.0', value: '-Infinity' },
        collidingNumMap: {
          type: 'pyric/map/1.0',
          fields: { type: 'pyric/number/1.0', value: '-0' },
        },
      },
    });
  });

  test('sessionUpdateDocOp drops omitted sentinel paths via deleteFields and sets partial on object and variadic forms', () => {
    expect(
      sessionUpdateDocOp('spaces/s1', [
        {
          updatedBy: 'u-1',
          members: arrayRemove('u-2'),
          legacy: deleteField(),
        },
      ]),
    ).toEqual({
      ok: true,
      value: {
        kind: 'update',
        path: 'spaces/s1',
        data: { updatedBy: 'u-1' },
        deleteFields: ['members', 'legacy'],
        partial: true,
      },
    });

    expect(
      sessionUpdateDocOp('spaces/s1', [
        new FieldPath('meta', 'version'),
        increment(1),
        'title',
        'Beta',
      ]),
    ).toEqual({
      ok: true,
      value: {
        kind: 'update',
        path: 'spaces/s1',
        data: { title: 'Beta' },
        deleteFields: ['meta.version'],
        partial: true,
      },
    });
  });
});
