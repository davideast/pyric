/**
 * Tests for the rules-language snapshots, loader, and analyzer (issue #185
 * steps 1-2). Covers:
 *   - the loader's validations (the shipped snapshots pass; malformed inputs
 *     fail through the same code path),
 *   - analyzer determinism on two fixture rulesets,
 *   - that every corpus scenario analyzes without error.
 */
import { describe, expect, it } from 'bun:test';
import {
  RULES_ENGINES,
  loadAllSnapshots,
  loadSnapshot,
  validateSnapshotValue,
} from '../rules-language/load.ts';
import { CONSTRUCT_KINDS } from '../rules-language/types.ts';
import {
  analyze,
  analyzeFirestore,
  analyzeRtdb,
  analyzeStorage,
} from './rules-language-analyzer.ts';
import { ALL_RULES_FIRESTORE_PACKS } from '../rules-corpus/firestore/index.ts';
import { ALL_RULES_STORAGE_PACKS } from '../rules-corpus/storage/index.ts';
import { ALL_RULES_RTDB_PACKS } from '../rules-corpus/rtdb/index.ts';

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
        expect(c.status).toBe('unprobed');
      }
    }
  });

  it('construct ids are unique within each engine', () => {
    for (const engine of RULES_ENGINES) {
      const ids = loadSnapshot(engine).constructs.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  // ── Loader validation: negative cases through validateSnapshotValue ──────
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

  it('rejects duplicate ids within an engine', () => {
    const snap = base();
    snap.constructs.push({ ...snap.constructs[0] });
    const problems = validateSnapshotValue('firestore', snap);
    expect(problems.some((p) => p.includes('duplicate id'))).toBe(true);
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
    const snap = base();
    expect(validateSnapshotValue('storage', snap).some((p) => p.includes('!= file engine'))).toBe(true);
  });

  it('rejects a construct missing its reference citation', () => {
    const snap = base();
    (snap.constructs[0] as { reference?: string }).reference = '';
    expect(validateSnapshotValue('firestore', snap).some((p) => p.includes('missing reference'))).toBe(true);
  });
});

describe('rules-language analyzer', () => {
  const FS_FIXTURE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
      allow create: if request.resource.data.keys().hasOnly(['name']) && request.resource.data.name is string;
    }
  }
}`;

  const ST_FIXTURE = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /u/{uid}/{file} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == uid && request.resource.size < 5 * 1024 * 1024;
    }
  }
}`;

  const RT_FIXTURE = JSON.stringify({
    '.read': 'auth != null',
    $uid: { '.write': "auth.uid === $uid && newData.hasChildren(['name'])" },
  });

  it('is deterministic: same ruleset → identical construct set (firestore)', () => {
    const a = [...analyzeFirestore(FS_FIXTURE).ids].sort();
    const b = [...analyzeFirestore(FS_FIXTURE).ids].sort();
    expect(a).toEqual(b);
    expect(a).toContain('firestore.binding.request.auth.uid');
    expect(a).toContain('firestore.rule-kind.allow-read');
    expect(a).toContain('firestore.rule-kind.allow-create');
    expect(a).toContain('firestore.operator.is');
    expect(a).toContain('firestore.method.map.keys');
  });

  it('is deterministic: same ruleset → identical construct set (storage)', () => {
    const a = [...analyzeStorage(ST_FIXTURE).ids].sort();
    const b = [...analyzeStorage(ST_FIXTURE).ids].sort();
    expect(a).toEqual(b);
    expect(a).toContain('storage.binding.request.resource.size');
    expect(a).toContain('storage.rule-kind.allow-write');
    expect(a).toContain('storage.operator.lt');
  });

  it('is deterministic: same rules JSON → identical construct set (rtdb)', () => {
    const a = [...analyzeRtdb(RT_FIXTURE).ids].sort();
    const b = [...analyzeRtdb(RT_FIXTURE).ids].sort();
    expect(a).toEqual(b);
    expect(a).toContain('rtdb.binding.auth');
    expect(a).toContain('rtdb.rule-kind.write');
    expect(a).toContain('rtdb.method.snapshot.hasChildren');
    expect(a).toContain('rtdb.rule-kind.location-wildcard');
  });

  it('only ever emits ids that exist in the engine snapshot', () => {
    const known = {
      firestore: new Set(loadSnapshot('firestore').constructs.map((c) => c.id)),
      storage: new Set(loadSnapshot('storage').constructs.map((c) => c.id)),
      rtdb: new Set(loadSnapshot('rtdb').constructs.map((c) => c.id)),
    };
    for (const id of analyzeFirestore(FS_FIXTURE).ids) expect(known.firestore.has(id)).toBe(true);
    for (const id of analyzeStorage(ST_FIXTURE).ids) expect(known.storage.has(id)).toBe(true);
    for (const id of analyzeRtdb(RT_FIXTURE).ids) expect(known.rtdb.has(id)).toBe(true);
  });

  it('analyzes every firestore corpus scenario without error', () => {
    const known = new Set(loadSnapshot('firestore').constructs.map((c) => c.id));
    for (const pack of ALL_RULES_FIRESTORE_PACKS) {
      const res = analyze('firestore', pack.rules);
      for (const id of res.ids) expect(known.has(id)).toBe(true);
    }
  });

  it('analyzes every storage corpus scenario without error', () => {
    const known = new Set(loadSnapshot('storage').constructs.map((c) => c.id));
    for (const pack of ALL_RULES_STORAGE_PACKS) {
      const res = analyze('storage', pack.rules);
      for (const id of res.ids) expect(known.has(id)).toBe(true);
    }
  });

  it('analyzes every rtdb corpus scenario without error', () => {
    const known = new Set(loadSnapshot('rtdb').constructs.map((c) => c.id));
    for (const pack of ALL_RULES_RTDB_PACKS) {
      const res = analyze('rtdb', pack.rules);
      for (const id of res.ids) expect(known.has(id)).toBe(true);
    }
  });
});
