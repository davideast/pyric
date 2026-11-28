import { describe, expect, test } from 'bun:test';
import { createRng } from './fuzz-prng.js';
import {
  generateFirestoreTransition,
  generateRtdbTransition,
  generateStandaloneFunction,
  generateStorageTransition,
  printExpr,
  printFunction,
  printTransition,
  shrinkExpr,
  shrinkFunctionProgram,
  type FuzzExpr,
} from './fuzz-grammar.js';
import { shrinkCounterexample } from './fuzz-values.js';
import { lowerRtdbExpression } from '../../src/policy/rtdb.js';
import { lowerStorage, compileStorageProjections } from '../../src/policy/storage.js';
import { firestoreGrammar, firestoreSemantics } from '../../src/grammar/FirestoreParser.js';
import type { Expression } from '../../src/grammar/FirestoreAST.js';

function parseExpr(src: string): Expression {
  const m = firestoreGrammar.match(src, 'Expr');
  if (m.failed()) throw new Error(m.message);
  return firestoreSemantics(m).toAST() as Expression;
}

describe('fuzz-grammar generators and AST shrinker', () => {
  test('generators are deterministic for identical seeds across all four targets', () => {
    const a = createRng(2026);
    const b = createRng(2026);
    for (let i = 0; i < 20; i++) {
      expect(printFunction(generateStandaloneFunction(a))).toBe(printFunction(generateStandaloneFunction(b)));
      expect(printTransition(generateFirestoreTransition(a))).toBe(printTransition(generateFirestoreTransition(b)));
      expect(printTransition(generateRtdbTransition(a))).toBe(printTransition(generateRtdbTransition(b)));
      expect(printTransition(generateStorageTransition(a, i % 2 === 0 ? 'create' : 'update')))
        .toBe(printTransition(generateStorageTransition(b, i % 2 === 0 ? 'create' : 'update')));
    }
  });

  test('generated RTDB and Storage expressions parse cleanly as valid Rules v2 expressions', () => {
    const rng = createRng(0x5eed);
    const storageProj = compileStorageProjections({
      'input.auth': 'request.auth',
      'after': 'request.resource',
      'before': 'resource',
    });
    let rtdbLowered = 0;
    let storageLowered = 0;
    for (let i = 0; i < 50; i++) {
      const rtdbProg = generateRtdbTransition(rng);
      const rtdbExpr = parseExpr(printExpr(rtdbProg.requirements[0]!.expr));
      const loweredR = lowerRtdbExpression(rtdbExpr, { before: 'data', after: 'newData' }, { checkTiming: true });
      if (loweredR.predicate) rtdbLowered++;

      const stProg = generateStorageTransition(rng, i % 2 === 0 ? 'create' : 'update');
      const stExpr = parseExpr(printExpr(stProg.requirements[0]!.expr));
      const loweredS = lowerStorage(stExpr, storageProj);
      if (loweredS.predicate) storageLowered++;
    }
    expect(rtdbLowered).toBeGreaterThanOrEqual(40);
    expect(storageLowered).toBe(50);
  });

  test('AST shrinker minimizes complex counterexample expressions deterministically', () => {
    const complex: FuzzExpr = {
      kind: 'binary',
      op: '&&',
      left: { kind: 'binary', op: '+', left: { kind: 'var', name: 'a' }, right: { kind: 'lit', value: 1, raw: '1' } },
      right: {
        kind: 'ternary',
        cond: { kind: 'lit', value: true },
        yes: { kind: 'binary', op: '/', left: { kind: 'lit', value: 1, raw: '1' }, right: { kind: 'lit', value: 0, raw: '0' } },
        no: { kind: 'lit', value: false },
      },
    };
    const shrunk = shrinkCounterexample(
      complex,
      shrinkExpr,
      (e) => printExpr(e).includes('/'),
    );
    expect(printExpr(shrunk.value)).toBe('(0 / 0)');
  });

  test('program shrinker drops unused lets and shrinks body', () => {
    const rng = createRng(99);
    const prog = generateStandaloneFunction(rng);
    const shrunk = shrinkCounterexample(
      { ...prog, lets: [{ name: 'unused', value: { kind: 'lit', value: 99, raw: '99' } }, ...prog.lets] },
      shrinkFunctionProgram,
      (p) => printFunction(p).includes('fuzzFn'),
    );
    expect(shrunk.value.lets.length).toBe(0);
  });
});
