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
  computeCoverageReport,
} from './rules-language-analyzer.ts';
import { ALL_RULES_FIRESTORE_SCENARIOS } from '../rules-corpus/firestore/index.ts';
import { ALL_RULES_STORAGE_SCENARIOS } from '../rules-corpus/storage/index.ts';
import { ALL_RULES_RTDB_SCENARIOS } from '../rules-corpus/rtdb/index.ts';

describe('rules-language production verdicts', () => {
  it('does not count constructs whose positive evidence is contaminated by a production divergence', async () => {
    const report = await computeCoverageReport();
    const firestore = report.engines.find((engine) => engine.engine === 'firestore');

    expect(firestore?.constructs.find((construct) => construct.id === 'firestore.binding.resource.id')?.verdict).toBe('diverged');
    expect(firestore?.constructs.find((construct) => construct.id === 'firestore.binding.resource.__name__')?.verdict).toBe('diverged');
    expect(firestore?.verifiedConstructs).toBe(107);
  });

  it('removes RTDB validate scope from the numerator while the ancestor case diverges', async () => {
    const report = await computeCoverageReport();
    const rtdb = report.engines.find((engine) => engine.engine === 'rtdb');

    expect(rtdb?.constructs.find((construct) => construct.id === 'rtdb.semantic.validate-non-cascade')?.verdict).toBe('diverged');
    expect(rtdb?.verifiedConstructs).toBe(54);
  });
});

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

  // ── Production acceptance probe status (issue #185 step 5) ──────────────
  //
  // firestore + storage are probed against the live Rules Test API
  // (rules-language-acceptance.ts): every construct there has advanced past
  // 'unprobed' to accepted/rejected/unprobeable. RTDB has no Test API and is
  // explicitly out of scope for the credentialed probe, so it stays
  // 'unprobed'.
  it('firestore + storage constructs have all been probed (no longer unprobed)', () => {
    for (const engine of ['firestore', 'storage'] as const) {
      for (const c of loadSnapshot(engine).constructs) {
        expect(['accepted', 'rejected', 'unprobeable']).toContain(c.status);
      }
    }
  });

  it('rtdb constructs stay unprobed (no Test API for RTDB rules; out of scope)', () => {
    for (const c of loadSnapshot('rtdb').constructs) {
      expect(c.status).toBe('unprobed');
    }
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

  it('accepts the unprobeable status when paired with a probeNote', () => {
    const snap = base();
    (snap.constructs[0] as { status: string; probeNote?: string }).status = 'unprobeable';
    (snap.constructs[0] as { status: string; probeNote?: string }).probeNote = 'no generator for this construct kind';
    expect(validateSnapshotValue('firestore', snap)).toEqual([]);
  });

  it('rejects a rejected-status construct with no probeNote', () => {
    const snap = base();
    (snap.constructs[0] as { status: string }).status = 'rejected';
    expect(
      validateSnapshotValue('firestore', snap).some((p) => p.includes('requires a non-empty probeNote')),
    ).toBe(true);
  });

  it('rejects an unprobeable-status construct with no probeNote', () => {
    const snap = base();
    (snap.constructs[0] as { status: string }).status = 'unprobeable';
    expect(
      validateSnapshotValue('firestore', snap).some((p) => p.includes('requires a non-empty probeNote')),
    ).toBe(true);
  });

  it('rejects an empty-string probeNote', () => {
    const snap = base();
    (snap.constructs[0] as { status: string; probeNote?: string }).status = 'rejected';
    (snap.constructs[0] as { status: string; probeNote?: string }).probeNote = '';
    expect(
      validateSnapshotValue('firestore', snap).some((p) => p.includes('probeNote present but empty')),
    ).toBe(true);
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
    for (const pack of ALL_RULES_FIRESTORE_SCENARIOS) {
      const res = analyze('firestore', pack.rules);
      for (const id of res.ids) expect(known.has(id)).toBe(true);
    }
  });

  it('analyzes every storage corpus scenario without error', () => {
    const known = new Set(loadSnapshot('storage').constructs.map((c) => c.id));
    for (const pack of ALL_RULES_STORAGE_SCENARIOS) {
      const res = analyze('storage', pack.rules);
      for (const id of res.ids) expect(known.has(id)).toBe(true);
    }
  });

  it('analyzes every rtdb corpus scenario without error', () => {
    const known = new Set(loadSnapshot('rtdb').constructs.map((c) => c.id));
    for (const pack of ALL_RULES_RTDB_SCENARIOS) {
      const res = analyze('rtdb', pack.rules);
      for (const id of res.ids) expect(known.has(id)).toBe(true);
    }
  });
});

describe('rules-language analyzer: duration/timestamp receiver-type inference', () => {
  const rules = (expr: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /x/{id} {
      allow create: if ${expr};
    }
  }
}`;

  it('credits duration.seconds/nanos when the receiver is a namespace duration constructor', () => {
    const res = analyzeFirestore(
      rules("duration.time(1, 0, 0, 0).seconds() >= 0 && duration.value(5, 's').nanos() >= 0"),
    );
    expect(res.ids).toContain('firestore.method.duration.seconds');
    expect(res.ids).toContain('firestore.method.duration.nanos');
    expect(res.ids).not.toContain('firestore.method.timestamp.seconds');
    expect(res.ids).not.toContain('firestore.method.timestamp.nanos');
    expect(res.unresolved).toEqual([]);
  });

  it('credits timestamp.seconds/nanos when the receiver is request.time', () => {
    const res = analyzeFirestore(rules('request.time.seconds() >= 0 && request.time.nanos() >= 0'));
    expect(res.ids).toContain('firestore.method.timestamp.seconds');
    expect(res.ids).toContain('firestore.method.timestamp.nanos');
    expect(res.ids).not.toContain('firestore.method.duration.seconds');
    expect(res.ids).not.toContain('firestore.method.duration.nanos');
    expect(res.unresolved).toEqual([]);
  });

  it('credits duration.seconds when the receiver is a timestamp-minus-timestamp difference', () => {
    const res = analyzeFirestore(rules('(request.time - timestamp.value(0)).seconds() >= 0'));
    expect(res.ids).toContain('firestore.method.duration.seconds');
    expect(res.ids).not.toContain('firestore.method.timestamp.seconds');
    expect(res.unresolved).toEqual([]);
  });

  it('credits timestamp.seconds when the receiver is a timestamp-minus-duration (still a timestamp)', () => {
    const res = analyzeFirestore(rules("(request.time - duration.value(5, 's')).seconds() >= 0"));
    expect(res.ids).toContain('firestore.method.timestamp.seconds');
    expect(res.ids).not.toContain('firestore.method.duration.seconds');
  });

  it('does NOT credit either receiver when the type is indeterminate — stays unresolved', () => {
    // `request.resource.data.customField` is an arbitrary map field: its type
    // cannot be known statically, so `.seconds()` is genuinely ambiguous
    // between the timestamp and duration receiver methods of the same name.
    // Under-crediting here is the honest outcome.
    const res = analyzeFirestore(rules('request.resource.data.customField.seconds() >= 0'));
    expect(res.ids).not.toContain('firestore.method.timestamp.seconds');
    expect(res.ids).not.toContain('firestore.method.duration.seconds');
    expect(res.unresolved.some((u) => u.what === 'method:seconds')).toBe(true);
  });
});

describe('rules-language analyzer: &&/|| error-absorption attribution', () => {
  const rules = (expr: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /x/{id} {
      allow create: if ${expr};
    }
  }
}`;

  it('credits error-absorption-or for `risky || true` (the non-short-circuit direction)', () => {
    const res = analyzeFirestore(rules("request.resource.data.missing > 0 || true"));
    expect(res.ids).toContain('firestore.semantic.error-absorption-or');
  });

  it('does NOT credit error-absorption-or for `true || risky` (ordinary short-circuit, no special semantic needed)', () => {
    const res = analyzeFirestore(rules('true || request.resource.data.missing > 0'));
    expect(res.ids).not.toContain('firestore.semantic.error-absorption-or');
  });

  it('does NOT credit error-absorption-or for `risky || false` (the error genuinely propagates)', () => {
    const res = analyzeFirestore(rules('request.resource.data.missing > 0 || false'));
    expect(res.ids).not.toContain('firestore.semantic.error-absorption-or');
  });

  it('credits error-absorption-and for `risky && false` (the non-short-circuit direction)', () => {
    const res = analyzeFirestore(rules('request.resource.data.missing > 0 && false'));
    expect(res.ids).toContain('firestore.semantic.error-absorption-and');
  });

  it('does NOT credit error-absorption-and for `false && risky` (ordinary short-circuit, no special semantic needed)', () => {
    const res = analyzeFirestore(rules('false && request.resource.data.missing > 0'));
    expect(res.ids).not.toContain('firestore.semantic.error-absorption-and');
  });

  it('does NOT credit error-absorption-and for `risky && true` (the error genuinely propagates)', () => {
    const res = analyzeFirestore(rules('request.resource.data.missing > 0 && true'));
    expect(res.ids).not.toContain('firestore.semantic.error-absorption-and');
  });

  it('does NOT credit absorption for a plain boolean &&/|| with no risky operand', () => {
    const res = analyzeFirestore(rules("request.auth != null && request.auth.uid == 'x'"));
    expect(res.ids).not.toContain('firestore.semantic.error-absorption-and');
    expect(res.ids).not.toContain('firestore.semantic.error-absorption-or');
  });
});

describe('rules-language: unattributable meta-semantics are excluded from the coverage denominator', () => {
  it('storage.semantic.deny-by-default and rtdb.semantic.deny-by-default carry a non-empty unattributable note', () => {
    const storageEntry = loadSnapshot('storage').constructs.find((c) => c.id === 'storage.semantic.deny-by-default');
    const rtdbEntry = loadSnapshot('rtdb').constructs.find((c) => c.id === 'rtdb.semantic.deny-by-default');
    expect(typeof storageEntry?.unattributable).toBe('string');
    expect((storageEntry?.unattributable ?? '').length).toBeGreaterThan(0);
    expect(typeof rtdbEntry?.unattributable).toBe('string');
    expect((rtdbEntry?.unattributable ?? '').length).toBeGreaterThan(0);
  });

  it('rejects an empty-string unattributable note', () => {
    const snap = {
      engine: 'firestore' as const,
      version: 'v',
      sources: ['s'],
      constructs: [
        {
          id: 'firestore.operator.eq',
          kind: 'operator',
          engine: 'firestore',
          reference: 'r',
          status: 'unprobed',
          unattributable: '',
        },
      ],
    };
    expect(
      validateSnapshotValue('firestore', snap).some((p) => p.includes('unattributable present but empty')),
    ).toBe(true);
  });
});
