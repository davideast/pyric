// Permanent regression tests pinning every bug discovered during differential fuzzing
// and adversarial red-team auditing across interpreter, ES module, Firestore, RTDB, and Storage.
import { afterAll, describe, expect, test } from 'bun:test';
import {
  compileBoundedModule,
  compileFunction,
  compilePolicy,
  interpretModule,
  type Transition,
  type Verdict,
} from '../../src/policy/index.js';
import { rtdbRules } from '../../src/api/rtdb.js';
import { storageRules } from '../../src/api/storage.js';
import { firestoreRules } from '../../src/api/firestore.js';
import { hostilePayloads } from './fuzz-values.js';
import {
  captureCall,
  createModuleLoader,
  decisionOf,
  normalizeVerdict,
  outcomesMatch,
  simulateFirestorePolicy,
  simulateRtdbPolicy,
  simulateStoragePolicy,
  verdictsMatch,
} from './fuzz-oracle.js';

const loader = createModuleLoader('pyric-diff-reg-');
afterAll(() => loader.cleanup());

describe('Differential fuzzing & red-team permanent regressions', () => {
  test('Reg-1: compilePolicy transitions support opt-in use extension methods; across all 5 engines', async () => {
    // Plain transitions without `use extension methods;` remain strictly closed
    expect(() => compilePolicy('transition closed { require r { return after.items.size() == 1; } }')).toThrow(/subset/);

    const storagePolicy = `
      use extension methods;
      transition voiceUpload {
        require validClip {
          return input.auth != null
            && input.auth.uid == after.metadata.get('owner', '')
            && after.contentType.matches('^audio/(wav|ogg)$')
            && after.size > 0
            && after.size <= 1024;
        }
      }
    `;
    const compiled = compilePolicy(storagePolicy);
    const mod = await loader.load(compiled.standaloneModule().moduleSource, 'reg1_storage');
    const modJudge = mod.judge as (t: Transition) => Verdict;

    const storageCases = [
      { auth: { uid: 'alice' }, after: { size: 512, contentType: 'audio/wav', metadata: { owner: 'alice' } }, want: 'ALLOW' },
      { auth: { uid: 'bob' }, after: { size: 512, contentType: 'audio/wav', metadata: { owner: 'alice' } }, want: 'DENY' },
      { auth: { uid: 'alice' }, after: { size: 512, contentType: 'audio/mp3', metadata: { owner: 'alice' } }, want: 'DENY' },
      { auth: { uid: 'alice' }, after: { size: 512, contentType: 'audio/wav', metadata: {} }, want: 'DENY' },
      { auth: null, after: { size: 512, contentType: 'audio/wav', metadata: { owner: 'alice' } }, want: 'DENY' },
    ] as const;

    for (const c of storageCases) {
      const t: Transition = { before: null, after: c.after, input: { auth: c.auth } };
      const v1 = normalizeVerdict(compiled.judge(t));
      const v2 = normalizeVerdict(modJudge(t));
      const sim = simulateStoragePolicy(storagePolicy, { method: 'create', auth: c.auth, after: c.after });
      expect(sim.lowered).toBe(true);
      expect(decisionOf(v1)).toBe(c.want);
      expect(verdictsMatch(v1, v2)).toBe(true);
      expect(sim.decision).toBe(c.want);
    }

    const rtdbPolicy = `
      use extension methods;
      transition taggedText {
        require checkTag {
          return after.s.size() >= 2 && after.s.size() <= 5 && after.x == before.x + 1;
        }
      }
    `;
    const rCompiled = compilePolicy(rtdbPolicy);
    const rMod = await loader.load(rCompiled.standaloneModule().moduleSource, 'reg1_rtdb');
    const rModJudge = rMod.judge as (t: Transition) => Verdict;
    for (const [before, after, want] of [
      [{ x: 1 }, { x: 2, s: 'ok' }, 'ALLOW'],
      [{ x: 1 }, { x: 2, s: 'a' }, 'DENY'],
      [{ x: 1 }, { x: 2, s: 'toolong' }, 'DENY'],
      [{ x: 1 }, { x: 3, s: 'ok' }, 'DENY'],
    ] as const) {
      const t: Transition = { before, after, input: {} };
      const v1 = normalizeVerdict(rCompiled.judge(t));
      const v2 = normalizeVerdict(rModJudge(t));
      const sim = simulateRtdbPolicy(rtdbPolicy, before, after);
      expect(sim.lowered).toBe(true);
      expect(decisionOf(v1)).toBe(want);
      expect(verdictsMatch(v1, v2)).toBe(true);
      expect(sim.decision).toBe(want);
    }

    const fsPolicy = `
      use extension methods;
      transition fsMethod {
        require check {
          return after.s.matches('^[a-z]+$') && after.tag in ['ok', 'go'];
        }
      }
    `;
    const fCompiled = compilePolicy(fsPolicy);
    const fMod = await loader.load(fCompiled.standaloneModule().moduleSource, 'reg1_fs');
    const fModJudge = fMod.judge as (t: Transition) => Verdict;
    for (const [after, want] of [
      [{ s: 'abc', tag: 'ok' }, 'ALLOW'],
      [{ s: 'ABC', tag: 'ok' }, 'DENY'],
      [{ s: 'abc', tag: 'no' }, 'DENY'],
    ] as const) {
      const t: Transition = { before: {}, after, input: {} };
      const v1 = normalizeVerdict(fCompiled.judge(t));
      const v2 = normalizeVerdict(fModJudge(t));
      const sim = simulateFirestorePolicy(fsPolicy, t);
      expect(sim.lowered).toBe(true);
      expect(decisionOf(v1)).toBe(want);
      expect(verdictsMatch(v1, v2)).toBe(true);
      expect(sim.decision).toBe(want);
    }
  });

  test('Reg-2: RTDB fail-open regressions (boolean ==/!=, negated boolean lets, >2^53 & canceling overflow, % 0)', async () => {
    const cases: readonly { src: string; before: Record<string, unknown>; after: Record<string, unknown>; want: 'ALLOW' | 'DENY' }[] = [
      { src: 'transition t { require r { return (after.x > 0 || after.y > 0) == false; } }', before: {}, after: {}, want: 'DENY' },
      { src: 'transition t { require r { return (after.x > 0 || after.y > 0) == false; } }', before: {}, after: { x: 'bad', y: -1 }, want: 'DENY' },
      { src: 'transition t { require r { return (after.x < after.y) == false; } }', before: {}, after: {}, want: 'DENY' },
      { src: 'transition t { require r { return (after.x > 0 || false) == (after.y > 0 || false); } }', before: {}, after: {}, want: 'DENY' },
      { src: 'transition t { require r { return after.x + 2 == after.x + 1; } }', before: {}, after: { x: 9007199254740991 }, want: 'DENY' },
      { src: 'transition t { require r { return after.x * after.x > 0; } }', before: {}, after: { x: 9007199254740991 }, want: 'DENY' },
      { src: 'transition t { require r { return (after.x * after.y) - (after.x * after.y) == 0; } }', before: {}, after: { x: 1000000000, y: 1000000000 }, want: 'DENY' },
      { src: 'transition t { require r { return (after.x * after.x) is number; } }', before: {}, after: { x: 9007199254740991 }, want: 'DENY' },
      { src: 'transition t { require r { return (after.x * after.x) != null; } }', before: {}, after: { x: 9007199254740991 }, want: 'DENY' },
      { src: 'transition t { require r { return (after.a > 0 ? after.b * after.b : 1) != null; } }', before: {}, after: { a: 1, b: 9007199254740991 }, want: 'DENY' },
      { src: 'transition t { require r { return (after.a > 0 ? after.b * after.b : 1) != null; } }', before: {}, after: { a: -1 }, want: 'ALLOW' },
      { src: 'transition t { require r { return ((before.flag ? after.x : after.y) + 1) > 5; } }', before: { flag: true }, after: { x: 5 }, want: 'ALLOW' },
    ];
    for (const c of cases) {
      const compiled = compilePolicy(c.src);
      const mod = await loader.load(compiled.standaloneModule().moduleSource, 'reg2');
      const modJudge = mod.judge as (t: Transition) => Verdict;
      const t: Transition = { before: c.before, after: c.after, input: {} };
      const v1 = normalizeVerdict(compiled.judge(t));
      const v2 = normalizeVerdict(modJudge(t));
      const sim = simulateRtdbPolicy(c.src, c.before, c.after);
      expect(sim.lowered, c.src).toBe(true);
      expect(verdictsMatch(v1, v2), c.src).toBe(true);
      expect(sim.decision, c.src).toBe(c.want);
    }

    // Negated boolean let in compileFunction().rtdbPredicate
    const fn = compileFunction('function f(after) { let ok = after.x > 0 || after.y > 0; return !ok; }');
    const pred = fn.rtdbPredicate({ after: 'newData' });
    const rules = rtdbRules({ rules: { item: { '.write': 'newData.exists()', '.validate': pred } } });
    expect(rules.simulate([{ path: '/item', operation: 'write', expectation: 'DENY', data: {}, newData: { _keep: true } }]).cases[0]?.decision).toBe('DENY');
    expect(rules.simulate([{ path: '/item', operation: 'write', expectation: 'ALLOW', data: {}, newData: { x: -1, y: -2 } }]).cases[0]?.decision).toBe('ALLOW');

    // Non-constant % divisor refused by policy.rtdb
    const modPolicy = compilePolicy('transition t { require r { return !(after.x % after.y == 0); } }');
    expect(modPolicy.rtdb({ after: 'newData' }, 'mixed')[0]?.predicate).toBeUndefined();
  });

  test('Reg-3: Storage absent-root polarity bypasses and bind.rtdb disjunction bypasses rejected', () => {
    const bypasses = [
      'transition t { require r { return (input.auth != null) ? false : true; } }',
      'transition t { require r { return !(input.auth != null && true); } }',
      'transition t { require r { return (input.auth != null) == false; } }',
      'transition t { require r { return !(input.auth is map); } }',
      'transition t { require r { return input.auth != 1; } }',
    ];
    for (const src of bypasses) {
      const rows = compilePolicy(src).storage({ 'input.auth': 'request.auth' }, 'mixed');
      expect(rows[0]?.predicate, src).toBeUndefined();
      expect(rows[0]?.reason, src).toContain('diverges');
    }

    // bind.rtdb rejects disjunction bypass `true || <pred>`
    const inc = compilePolicy('transition t { require r { return after.x > 0; } }');
    const bound = inc.bind.rtdb({ path: '/item', bindings: { after: 'newData' } });
    const pred = bound.requirements[0]!.predicate!;
    expect(() => bound.verify({ rules: { item: { '.validate': `true || ${pred}` } } })).toThrow(/Missing \.validate placement/);
    expect(() => bound.verify({ rules: { item: { '.validate': `auth != null && ${pred}` } } })).not.toThrow();
  });

  test('Reg-4: int64 boundaries, RE2 full-string matches, slicing, sets, map diff, timestamp/duration/bytes parity', async () => {
    const src = `
      use extension bounded;
      export function intEdges() {
        return {
          'minDivNeg1': (-9223372036854775808) / (-1),
          'minModNeg1': (-9223372036854775808) % (-1),
          'negMinErr': (-(-9223372036854775808) == 0) || true,
          'absMinErr': (math.abs(-9223372036854775808) == 0) || true,
          'maxPlusOneErr': (9223372036854775807 + 1 == 0) || true,
          'minMinusOneErr': (-9223372036854775808 - 1 == 0) || true,
          'intNan': int(float('NaN')),
          'intInfErr': (int(float('Infinity')) == 0) || true,
          'negZeroFloat': float('-0.0') is float
        };
      }
      export function re2AndStrings(s) {
        return {
          'fullMatch': s.matches('abc'),
          'anchorMatch': s.matches('^a[0-9]+z$'),
          'altMatch': s.matches('(foo|bar)[0-9]?'),
          'rep': s.replace('[0-9]+', '#'),
          'spl': s.split(','),
          'low': s.lower(),
          'up': s.upper(),
          'trm': s.trim()
        };
      }
      export function collectionsAndTypes(xs, a, b) {
        let s1 = [1, 2, 3].toSet();
        let s2 = [2, 3, 4].toSet();
        let d = b.diff(a);
        let t = timestamp.date(2026, 1, 15);
        let dur = duration.value(90, 's');
        let raw = b'abc';
        return {
          'slice': xs[0:2],
          'unionSize': s1.union(s2).size(),
          'interSize': s1.intersection(s2).size(),
          'diffSize': s1.difference(s2).size(),
          'added': d.addedKeys().hasOnly(['c']),
          'changed': d.changedKeys().hasOnly(['b']),
          'removed': d.removedKeys().hasOnly(['a']),
          'year': t.year(),
          'month': t.month(),
          'day': t.day(),
          'plusSec': (t + dur).seconds() - t.seconds(),
          'bytesLen': raw.size(),
          'b64': raw.toBase64(),
          'hex': raw.toHexString()
        };
      }
    `;
    const compiled = compileBoundedModule(src);
    const mod = await loader.load(compiled.moduleSource, 'reg4');
    const interp = interpretModule(src);

    expect(outcomesMatch(captureCall(() => interp.intEdges!()), captureCall(() => mod.intEdges!()))).toBe(true);

    for (const s of ['abc', 'xabc', 'a123z', 'foo', 'bar9', 'a1,b2,c3', '  Hi  ', '']) {
      const o1 = captureCall(() => interp.re2AndStrings!(s));
      const o2 = captureCall(() => mod.re2AndStrings!(s));
      expect(outcomesMatch(o1, o2), `re2AndStrings(${JSON.stringify(s)}): interp=${JSON.stringify(o1)} mod=${JSON.stringify(o2)}`).toBe(true);
    }

    const col1 = captureCall(() => interp.collectionsAndTypes!([10, 20, 30], { a: 1, b: 2 }, { b: 9, c: 3 }));
    const col2 = captureCall(() => mod.collectionsAndTypes!([10, 20, 30], { a: 1, b: 2 }, { b: 9, c: 3 }));
    expect(outcomesMatch(col1, col2), `collectionsAndTypes: interp=${JSON.stringify(col1)} mod=${JSON.stringify(col2)}`).toBe(true);
    expect(col1.kind).toBe('value');

    // Out-of-bounds / invalid slice errors match
    for (const bad of [[], [1], 'x']) {
      const b1 = captureCall(() => interp.collectionsAndTypes!(bad, {}, {}));
      const b2 = captureCall(() => mod.collectionsAndTypes!(bad, {}, {}));
      expect(outcomesMatch(b1, b2), `bad slice ${JSON.stringify(bad)}`).toBe(true);
      expect(b1.kind).toBe('eval-error');
    }
  });

  test('Reg-5: compilePolicy().standaloneModule().judge() rejects all hostile payloads without invoking getters', async () => {
    const policy = compilePolicy('transition guard { require r { return after.a == 1; } }');
    const mod = await loader.load(policy.standaloneModule().moduleSource, 'reg5');
    const modJudge = mod.judge as (t: Transition) => Verdict;

    for (const hostile of hostilePayloads()) {
      const built = hostile.build();
      const out = captureCall(() => modJudge({ before: {}, after: built.payload, input: {} }));
      expect(built.wasGetterInvoked(), `standalone judge invoked getter on ${hostile.label}`).toBe(false);
      // Either throws RuleError/ResourceLimitError or returns non-ok verdict
      if (out.kind === 'value') {
        expect((out.value as Verdict).ok, `standalone judge accepted ${hostile.label}`).toBe(false);
      }
    }
  });

  test('Reg-6: policy.storageModule() and policy.bind.storage() compile and simulate end-to-end', () => {
    const policy = compilePolicy(`
      use extension methods;
      transition avatarWrite {
        require authAndType {
          return input.auth != null
            && after.contentType.matches('^image/(png|jpeg)$')
            && after.size <= 4096;
        }
      }
    `);
    const modSrc = policy.storageModule({ 'input.auth': 'request.auth', after: 'request.resource' });
    expect(modSrc).toContain("rules_version = '2+modules';");
    expect(modSrc).toContain('export function avatarWrite()');

    const template = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    function avatarPolicy() { return false; }',
      '    match /avatars/{uid}/{file} {',
      '      allow create: if request.auth.uid == uid && avatarPolicy();',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const bound = policy.bind.storage({
      rules: template,
      slot: 'avatarPolicy',
      placements: [
        {
          path: '/b/{bucket}/o/avatars/{uid}/{file}',
          operation: 'create',
          bindings: { 'input.auth': 'request.auth', after: 'request.resource' },
        },
      ],
    });
    const sim = storageRules(bound.rules, { bucket: 'test-bucket' }).simulate([
      {
        description: 'valid png upload',
        expectation: 'ALLOW',
        method: 'create',
        path: 'avatars/alice/me.png',
        auth: { uid: 'alice' },
        requestResource: { size: 1024, contentType: 'image/png' },
      },
      {
        description: 'wrong content type denied',
        expectation: 'DENY',
        method: 'create',
        path: 'avatars/alice/me.txt',
        auth: { uid: 'alice' },
        requestResource: { size: 100, contentType: 'text/plain' },
      },
      {
        description: 'wrong owner denied by template guard',
        expectation: 'DENY',
        method: 'create',
        path: 'avatars/alice/me.png',
        auth: { uid: 'bob' },
        requestResource: { size: 1024, contentType: 'image/png' },
      },
    ]);
    expect(sim.failed).toBe(0);
    expect(sim.passed).toBe(3);

    // Also verify firestoreRules agrees on lowered policy.firestoreModule
    const fsPol = compilePolicy('transition docCheck { require r { return after.count == before.count + 1 && after.count <= 10; } }');
    const fsMod = fsPol.firestoreModule({ 'before.count': 'resource.data.count', 'after.count': 'request.resource.data.count' });
    expect(fsMod).toContain('export function docCheck()');
    const fsSim = firestoreRules(`
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /counters/{id} {
            allow update: if ${fsPol.firestore({ 'before.count': 'resource.data.count', 'after.count': 'request.resource.data.count' })[0]!.predicate};
          }
        }
      }
    `).simulate([
      { description: 'ok', expectation: 'ALLOW', method: 'update', path: 'counters/c1', resource: { count: 4 }, data: { count: 5 } },
      { description: 'skip', expectation: 'DENY', method: 'update', path: 'counters/c1', resource: { count: 4 }, data: { count: 6 } },
    ]);
    expect(fsSim.passed).toBe(2);
  });
});
