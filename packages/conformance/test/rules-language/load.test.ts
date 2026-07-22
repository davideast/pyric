import { describe, expect, it } from 'bun:test';
import {
  RULES_ENGINES,
  loadAllSnapshots,
  loadSnapshot,
  validateSnapshotValue,
} from '../../rules-language/load.ts';
import { CONSTRUCT_KINDS } from '../../rules-language/types.ts';

describe('rules-language snapshots + loader', () => {
  it('loads and validates all three shipped snapshots', () => {
    const all = loadAllSnapshots();
    for (const engine of RULES_ENGINES) {
      expect(all[engine].engine).toBe(engine);
      expect(all[engine].constructs.length).toBeGreaterThan(0);
    }
  });

  it('every construct has a legal kind and (only methods) a receiverType', () => {
    for (const engine of RULES_ENGINES) {
      for (const c of loadSnapshot(engine).constructs) {
        expect(CONSTRUCT_KINDS).toContain(c.kind);
        if (c.kind === 'method') expect(typeof c.receiverType).toBe('string');
        else expect(c.receiverType).toBeUndefined();
        expect(c.engine).toBe(engine);
        expect(c.reference.length).toBeGreaterThan(0);
      }
    }
  });

  it('firestore + storage constructs have all been probed', () => {
    for (const engine of ['firestore', 'storage'] as const) {
      for (const c of loadSnapshot(engine).constructs) {
        expect(['accepted', 'rejected', 'unprobeable']).toContain(c.status);
      }
    }
  });

  it('rtdb constructs stay unprobed because RTDB has no Rules Test API', () => {
    for (const c of loadSnapshot('rtdb').constructs) expect(c.status).toBe('unprobed');
  });

  it('every rejected or unprobeable construct carries a non-empty probeNote', () => {
    for (const engine of RULES_ENGINES) {
      for (const c of loadSnapshot(engine).constructs) {
        if (c.status === 'rejected' || c.status === 'unprobeable') {
          expect(typeof c.probeNote).toBe('string');
          expect((c.probeNote ?? '').length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('construct ids are unique within each engine', () => {
    for (const engine of RULES_ENGINES) {
      const ids = loadSnapshot(engine).constructs.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  const base = () => ({
    engine: 'firestore' as const,
    version: 'v',
    sources: ['s'],
    constructs: [
      { id: 'firestore.operator.eq', kind: 'operator', engine: 'firestore', reference: 'r', status: 'unprobed' },
    ],
  });

  it('accepts a well-formed snapshot value', () => {
    expect(validateSnapshotValue('firestore', base())).toEqual([]);
  });

  it('rejects accepted Firestore evidence without digest and evaluation agreement', () => {
    const snap = base();
    (snap.constructs[0] as { status: string }).status = 'accepted';
    const problems = validateSnapshotValue('firestore', snap);
    expect(problems.some((problem) => problem.includes('requires a probeDigest'))).toBe(true);
    expect(problems.some((problem) => problem.includes('requires probeEvaluationAgreement'))).toBe(true);
  });

  it('rejects duplicate ids within an engine', () => {
    const snap = base();
    snap.constructs.push({ ...snap.constructs[0] });
    expect(validateSnapshotValue('firestore', snap).some((p) => p.includes('duplicate id'))).toBe(true);
  });

  it('rejects an illegal kind', () => {
    const snap = base();
    (snap.constructs[0] as { kind: string }).kind = 'not-a-kind';
    expect(validateSnapshotValue('firestore', snap).some((p) => p.includes('illegal kind'))).toBe(true);
  });

  it('rejects a method construct with no receiverType', () => {
    const snap = base();
    (snap.constructs[0] as { kind: string; id: string }).kind = 'method';
    (snap.constructs[0] as { id: string }).id = 'firestore.method.string.matches';
    expect(validateSnapshotValue('firestore', snap).some((p) => p.includes('missing receiverType'))).toBe(true);
  });

  it('rejects a non-method construct that carries a receiverType', () => {
    const snap = base();
    (snap.constructs[0] as Record<string, unknown>).receiverType = 'string';
    expect(validateSnapshotValue('firestore', snap).some((p) => p.includes('carries receiverType'))).toBe(true);
  });

  it('rejects an engine mismatch between file and construct', () => {
    expect(validateSnapshotValue('storage', base()).some((p) => p.includes('!= file engine'))).toBe(true);
  });

  it('rejects a construct missing its reference citation', () => {
    const snap = base();
    (snap.constructs[0] as { reference?: string }).reference = '';
    expect(validateSnapshotValue('firestore', snap).some((p) => p.includes('missing reference'))).toBe(true);
  });

  it('accepts the unprobeable status when paired with a probeNote', () => {
    const snap = base();
    (snap.constructs[0] as { status: string; probeNote?: string }).status = 'unprobeable';
    (snap.constructs[0] as { probeNote?: string }).probeNote = 'no generator for this construct kind';
    expect(validateSnapshotValue('firestore', snap)).toEqual([]);
  });

  for (const status of ['rejected', 'unprobeable'] as const) {
    it(`rejects ${status} status with no probeNote`, () => {
      const snap = base();
      (snap.constructs[0] as { status: string }).status = status;
      expect(validateSnapshotValue('firestore', snap).some((p) => p.includes('requires a non-empty probeNote'))).toBe(true);
    });
  }

  it('rejects an empty-string probeNote', () => {
    const snap = base();
    (snap.constructs[0] as { status: string; probeNote?: string }).status = 'rejected';
    (snap.constructs[0] as { probeNote?: string }).probeNote = '';
    expect(validateSnapshotValue('firestore', snap).some((p) => p.includes('probeNote present but empty'))).toBe(true);
  });

  it('requires unattributable meta-semantics to explain their exclusion', () => {
    for (const [engine, id] of [
      ['storage', 'storage.semantic.deny-by-default'],
      ['rtdb', 'rtdb.semantic.deny-by-default'],
    ] as const) {
      const entry = loadSnapshot(engine).constructs.find((construct) => construct.id === id);
      expect(typeof entry?.unattributable).toBe('string');
      expect((entry?.unattributable ?? '').length).toBeGreaterThan(0);
    }

    const snap = base();
    (snap.constructs[0] as { unattributable?: string }).unattributable = '';
    expect(validateSnapshotValue('firestore', snap).some((p) => p.includes('unattributable present but empty'))).toBe(true);
  });
});
