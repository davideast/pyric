/**
 * Boundary tests for the enum candidate detection introduced in Item 1.2.
 *
 * Threshold (Phase 3.2 lock): distinct values <= DEFAULT_ENUM_THRESHOLD (10).
 * The "distinct count <= samplesSeen / 2" half of the lock is finalization-
 * time only and is asserted separately at output projection (not here).
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ENUM_THRESHOLD,
  emptySchema,
  mergeDoc,
  type FieldObservation,
} from '../../src/discover/merge.js';
import type { FieldSchema, SchemaChange } from '../../src/discover/types.js';

const obsString = (v: string): FieldObservation => ({
  type: { kind: 'scalar', type: 'string' },
  isNull: false,
  example: v,
  enumSample: v,
});

const obsInt = (v: number): FieldObservation => ({
  type: { kind: 'scalar', type: 'integer' },
  isNull: false,
  example: v,
  enumSample: v,
});

const obsBool = (v: boolean): FieldObservation => ({
  type: { kind: 'scalar', type: 'boolean' },
  isNull: false,
  example: v,
});

function feedAll(
  docs: Record<string, FieldObservation>[],
): { schema: FieldSchema; changes: SchemaChange[] } {
  let schema = emptySchema();
  const changes: SchemaChange[] = [];
  for (const doc of docs) {
    const r = mergeDoc(schema, doc);
    schema = r.next;
    changes.push(...r.changes);
  }
  return { schema, changes };
}

// ─── State transitions ───────────────────────────────────────────────────

describe('enum candidate state machine', () => {
  test('single observation: candidate exists but does not qualify', () => {
    const { schema, changes } = feedAll([{ status: obsString('open') }]);
    expect(schema.fields.status!.enumCandidate?.values).toEqual(['open']);
    expect(schema.fields.status!.enumCandidate?.qualifies).toBe(false);
    expect(changes.some((c) => c.kind === 'enum_added')).toBe(false);
  });

  test('two distinct values: emits enum_added, qualifies=true', () => {
    const { schema, changes } = feedAll([
      { status: obsString('open') },
      { status: obsString('closed') },
    ]);
    expect(schema.fields.status!.enumCandidate?.qualifies).toBe(true);
    const added = changes.find((c) => c.kind === 'enum_added');
    expect(added?.kind).toBe('enum_added');
    if (added?.kind === 'enum_added') {
      expect(added.values).toEqual(['open', 'closed']);
    }
  });

  test('repeated value: no event', () => {
    const { changes } = feedAll([
      { status: obsString('open') },
      { status: obsString('open') },
      { status: obsString('open') },
    ]);
    expect(changes.filter((c) => c.kind === 'enum_widened')).toHaveLength(0);
    expect(changes.filter((c) => c.kind === 'enum_added')).toHaveLength(0);
  });

  test('subsequent new value: emits enum_widened', () => {
    const { changes } = feedAll([
      { status: obsString('a') },
      { status: obsString('b') },
      { status: obsString('c') },
    ]);
    expect(changes.filter((c) => c.kind === 'enum_added')).toHaveLength(1);
    expect(changes.filter((c) => c.kind === 'enum_widened')).toHaveLength(1);
  });

  test('exceeding threshold: emits enum_dropped(over_threshold)', () => {
    // 11 distinct values — first 10 fit, 11th drops.
    const docs: Record<string, FieldObservation>[] = [];
    for (let i = 0; i < DEFAULT_ENUM_THRESHOLD + 1; i++) {
      docs.push({ tag: obsString(`v${i}`) });
    }
    const { schema, changes } = feedAll(docs);
    const dropped = changes.find((c) => c.kind === 'enum_dropped');
    expect(dropped?.kind).toBe('enum_dropped');
    if (dropped?.kind === 'enum_dropped') {
      expect(dropped.reason).toBe('over_threshold');
    }
    expect(schema.fields.tag!.enumCandidate).toBeUndefined();
  });

  test('exactly threshold values: qualifies, no drop', () => {
    const docs: Record<string, FieldObservation>[] = [];
    for (let i = 0; i < DEFAULT_ENUM_THRESHOLD; i++) {
      docs.push({ tag: obsString(`v${i}`) });
    }
    const { schema, changes } = feedAll(docs);
    expect(schema.fields.tag!.enumCandidate?.values).toHaveLength(DEFAULT_ENUM_THRESHOLD);
    expect(changes.some((c) => c.kind === 'enum_dropped')).toBe(false);
  });
});

// ─── Type-widening drops the candidate ────────────────────────────────────

describe('enum candidate dropped on type widen', () => {
  test('string + integer union → enum_dropped(type_widened)', () => {
    const { schema, changes } = feedAll([
      { status: obsString('open') },
      { status: obsString('closed') },
      { status: obsInt(7) },
    ]);
    const dropped = changes.find((c) => c.kind === 'enum_dropped');
    expect(dropped?.kind).toBe('enum_dropped');
    if (dropped?.kind === 'enum_dropped') {
      expect(dropped.reason).toBe('type_widened');
    }
    expect(schema.fields.status!.enumCandidate).toBeUndefined();
  });
});

// ─── Eligibility ──────────────────────────────────────────────────────────

describe('enum candidate eligibility', () => {
  test('boolean fields are not enum candidates', () => {
    const { schema, changes } = feedAll([
      { active: obsBool(true) },
      { active: obsBool(false) },
    ]);
    expect(schema.fields.active!.enumCandidate).toBeUndefined();
    expect(changes.some((c) => c.kind === 'enum_added')).toBe(false);
  });

  test('integer fields ARE enum candidates', () => {
    const { schema } = feedAll([{ priority: obsInt(1) }, { priority: obsInt(2) }]);
    expect(schema.fields.priority!.enumCandidate?.qualifies).toBe(true);
  });
});
