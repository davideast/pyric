/**
 * Unit tests for the discover_paths merge module.
 *
 * Covers the Phase 2.1 convergence guarantees that the validation v1 scope
 * locked in: stable streams declare cleanly, drift later than `stopOnStable`
 * docs after the last change is mathematically undetectable, null
 * observations don't enter `types[]`, vector dim drift surfaces as a
 * dedicated change kind.
 */

import { describe, expect, test } from 'bun:test';
import {
  emptySchema,
  fieldTypeKey,
  mergeDoc,
  runConvergence,
  type FieldObservation,
} from '../../src/discover/merge.js';
import type { FieldType } from '../../src/discover/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

const obsScalar = (
  type:
    | 'null'
    | 'boolean'
    | 'integer'
    | 'double'
    | 'timestamp'
    | 'string'
    | 'bytes'
    | 'geopoint',
  example?: string | number | boolean,
  enumSample?: string | number,
): FieldObservation => ({
  type: { kind: 'scalar', type },
  isNull: type === 'null',
  example: example ?? (type === 'null' ? null : undefined),
  enumSample,
});

const obsVector = (dim: number): FieldObservation => ({
  type: { kind: 'vector', dimension: dim },
  isNull: false,
});

const obsArray = (elementTypes: FieldType[]): FieldObservation => ({
  type: { kind: 'array', elementTypes },
  isNull: false,
});

// ─── Type key dedup ───────────────────────────────────────────────────────

describe('fieldTypeKey', () => {
  test('NaN/+Inf/-Inf doubles all collapse to s:double', () => {
    expect(fieldTypeKey({ kind: 'scalar', type: 'double' })).toBe('s:double');
    // Wire layer always emits `{kind:'scalar', type:'double'}` regardless of
    // the underlying numeric value — the value never reaches the type key.
    // This test pins the contract.
  });

  test('vector dimension is part of the key (drift is distinct)', () => {
    expect(fieldTypeKey({ kind: 'vector', dimension: 3 })).toBe('v:3');
    expect(fieldTypeKey({ kind: 'vector', dimension: 8 })).toBe('v:8');
  });

  test('reference target is the full template path', () => {
    expect(
      fieldTypeKey({ kind: 'reference', targetCollection: 'users/{uid}/posts' }),
    ).toBe('r:users/{uid}/posts');
  });
});

// ─── Stable scenarios ─────────────────────────────────────────────────────

describe('mergeDoc — stable scenarios', () => {
  test('homogeneous stream: 0 changes after first doc', () => {
    const docs: Record<string, FieldObservation>[] = Array.from({ length: 10 }, () => ({
      name: obsScalar('string', 'alice'),
      age: obsScalar('integer', 30),
    }));
    let schema = emptySchema();
    let changesAfterFirst = 0;
    for (let i = 0; i < docs.length; i++) {
      const { next, changes } = mergeDoc(schema, docs[i]!);
      schema = next;
      if (i > 0) changesAfterFirst += changes.length;
    }
    expect(changesAfterFirst).toBe(0);
    expect(schema.samplesSeen).toBe(10);
  });

  test('first doc emits field_added per key', () => {
    const { changes } = mergeDoc(emptySchema(), {
      name: obsScalar('string', 'alice'),
      age: obsScalar('integer', 30),
    });
    expect(changes.filter((c) => c.kind === 'field_added')).toHaveLength(2);
  });
});

// ─── Null handling (Phase 2.1 lock) ───────────────────────────────────────

describe('mergeDoc — null handling', () => {
  test('null observation does NOT add null to types[]', () => {
    let schema = emptySchema();
    schema = mergeDoc(schema, { x: obsScalar('string', 'a') }).next;
    schema = mergeDoc(schema, { x: obsScalar('null') }).next;
    expect(schema.fields.x!.types).toEqual([{ kind: 'scalar', type: 'string' }]);
    expect(schema.fields.x!.nullable).toBe(true);
  });

  test('null transition emits became_nullable, NOT type_expanded', () => {
    let schema = mergeDoc(emptySchema(), { x: obsScalar('string', 'a') }).next;
    const { changes } = mergeDoc(schema, { x: obsScalar('null') });
    expect(changes.some((c) => c.kind === 'became_nullable')).toBe(true);
    expect(
      changes.some(
        (c) => c.kind === 'type_expanded' && c.addedType.kind === 'scalar',
      ),
    ).toBe(false);
  });

  test('subsequent null observations do not re-emit became_nullable', () => {
    let schema = mergeDoc(emptySchema(), { x: obsScalar('string', 'a') }).next;
    schema = mergeDoc(schema, { x: obsScalar('null') }).next;
    const { changes } = mergeDoc(schema, { x: obsScalar('null') });
    expect(changes.some((c) => c.kind === 'became_nullable')).toBe(false);
  });

  test('null-only first observation: field surfaces as null kind, nullable=true', () => {
    const { next, changes } = mergeDoc(emptySchema(), { x: obsScalar('null') });
    expect(next.fields.x!.nullable).toBe(true);
    expect(next.fields.x!.types).toEqual([]);
    const fa = changes.find((c) => c.kind === 'field_added');
    expect(fa?.kind).toBe('field_added');
    if (fa?.kind === 'field_added') {
      expect(fa.type).toEqual({ kind: 'scalar', type: 'null' });
    }
  });
});

// ─── Type expansion ───────────────────────────────────────────────────────

describe('mergeDoc — type expansion', () => {
  test('string → string|integer emits type_expanded', () => {
    let schema = mergeDoc(emptySchema(), { x: obsScalar('string', 'a') }).next;
    const { changes, next } = mergeDoc(schema, { x: obsScalar('integer', 5) });
    expect(changes.some((c) => c.kind === 'type_expanded')).toBe(true);
    expect(next.fields.x!.types).toHaveLength(2);
  });

  test('vector dim drift emits vector_dim_drift, not type_expanded', () => {
    let schema = mergeDoc(emptySchema(), { vec: obsVector(3) }).next;
    const { changes, next } = mergeDoc(schema, { vec: obsVector(8) });
    expect(changes.some((c) => c.kind === 'vector_dim_drift')).toBe(true);
    expect(changes.some((c) => c.kind === 'type_expanded')).toBe(false);
    // Both dimensions kept distinct in types[] (Phase 1.2 lock).
    expect(next.fields.vec!.types.filter((t) => t.kind === 'vector')).toHaveLength(2);
  });
});

// ─── Array element growth ────────────────────────────────────────────────

describe('mergeDoc — array element growth', () => {
  test('empty-array no-op merge: empty doesn\'t override populated', () => {
    let schema = mergeDoc(emptySchema(), {
      tags: obsArray([{ kind: 'scalar', type: 'string' }]),
    }).next;
    const { next } = mergeDoc(schema, { tags: obsArray([]) });
    const arr = next.fields.tags!.types[0]!;
    expect(arr.kind).toBe('array');
    if (arr.kind === 'array') expect(arr.elementTypes).toHaveLength(1);
  });

  test('new array element type emits type_expanded with [] segment', () => {
    let schema = mergeDoc(emptySchema(), {
      tags: obsArray([{ kind: 'scalar', type: 'string' }]),
    }).next;
    const { changes } = mergeDoc(schema, {
      tags: obsArray([
        { kind: 'scalar', type: 'string' },
        { kind: 'scalar', type: 'integer' },
      ]),
    });
    const te = changes.find((c) => c.kind === 'type_expanded');
    expect(te?.kind).toBe('type_expanded');
    if (te?.kind === 'type_expanded') {
      expect(te.path).toEqual(['tags', '[]']);
    }
  });
});

// ─── Convergence runner ───────────────────────────────────────────────────

describe('runConvergence', () => {
  test('homogeneous stream declares at stopOnStable', () => {
    const docs = Array.from({ length: 20 }, () => ({
      x: obsScalar('string', 'a'),
    }));
    const result = runConvergence(docs, 5);
    // First doc emits field_added; docs 1-5 are stable; declaredAt = 5
    // (after consecutiveStable hits 5 on the 6th doc, index 5).
    expect(result.declaredAt).toBe(5);
    expect(result.missedChangesAfterDeclared).toEqual([]);
  });

  test('drift later than stopOnStable docs after declaration is missed (by design)', () => {
    // 10 stable docs, then drift at doc 20 — sOS=5 declares at doc 5,
    // misses the doc-20 change.
    const docs: Record<string, FieldObservation>[] = [];
    for (let i = 0; i < 20; i++) docs.push({ x: obsScalar('string', 'a') });
    docs.push({ x: obsScalar('string', 'a'), y: obsScalar('integer', 1) }); // drift
    const result = runConvergence(docs, 5);
    expect(result.declaredAt).not.toBeNull();
    expect(result.missedChangesAfterDeclared.length).toBeGreaterThan(0);
  });

  test('stable stream of length < stopOnStable never declares', () => {
    const docs = Array.from({ length: 3 }, () => ({ x: obsScalar('string', 'a') }));
    const result = runConvergence(docs, 5);
    expect(result.declaredAt).toBeNull();
  });
});
