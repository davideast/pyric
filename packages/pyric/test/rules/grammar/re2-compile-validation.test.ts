import { describe, expect, test } from 'bun:test';
import { firestoreRules, RulesCompileError } from '../../../src/rules/index.js';
import { evaluateStorageRules, parseStorageRules } from '../../../src/storage/index.js';

const astralStart = String.fromCodePoint(0x1f600);
const astralMid = String.fromCodePoint(0x1f601);
const astralEnd = String.fromCodePoint(0x1f602);

function evalBoth(rulePattern: string, input: string): { firestoreAllowed: boolean; storageAllowed: boolean } {
  const fsRuleset = firestoreRules(`
    rules_version = '2';
    service cloud.firestore {
      match /databases/{database}/documents {
        match /items/{id} {
          allow get: if resource.data.val.matches('${rulePattern}');
        }
      }
    }
  `);
  const fsSummary = fsRuleset.simulate([
    {
      description: 're2 compile probe',
      expectation: 'ALLOW',
      method: 'get',
      path: '/items/item-1',
      auth: { uid: 'u1' },
      resource: { val: input },
    },
  ]);

  const stRules = parseStorageRules(`
    rules_version = '2';
    service firebase.storage {
      match /b/{bucket}/o {
        match /items/{id} {
          allow get: if resource.metadata.val.matches('${rulePattern}');
        }
      }
    }
  `);
  const stRes = evaluateStorageRules(
    stRules,
    {
      request: {
        auth: { uid: 'u1', token: {} },
        method: 'get',
        path: 'b/test-bucket/o/items/item-1',
      },
      resource: {
        name: 'items/item-1',
        bucket: 'test-bucket',
        size: 4,
        contentType: 'text/plain',
        metadata: { val: input },
      },
    },
    new Date('2026-01-01T00:00:00Z'),
  );

  return {
    firestoreAllowed: fsSummary.cases[0]!.decision === 'ALLOW',
    storageAllowed: stRes.allowed,
  };
}

describe('RE2 compile-time pattern validation parity', () => {
  test('compiles and evaluates escaped backslash digits, 3-digit octals, class lookaround tokens, and POSIX+astral ranges', () => {
    expect(evalBoth('\\\\\\\\1', '\\1')).toEqual({ firestoreAllowed: true, storageAllowed: true });
    expect(evalBoth('\\\\101', 'A')).toEqual({ firestoreAllowed: true, storageAllowed: true });
    expect(evalBoth('[(?=a)]', '=')).toEqual({ firestoreAllowed: true, storageAllowed: true });
    expect(evalBoth('\\\\Q[a(?=b)\\\\1\\\\E', '[a(?=b)\\1')).toEqual({ firestoreAllowed: true, storageAllowed: true });
    expect(evalBoth(`[[:alpha:]][${astralStart}-${astralEnd}]`, `x${astralMid}`)).toEqual({
      firestoreAllowed: true,
      storageAllowed: true,
    });
  });

  test('still rejects genuine RE2-unsupported backreferences and lookarounds at compile time', () => {
    expect(() => evalBoth('(a)\\\\1', 'aa')).toThrow(RulesCompileError);
    expect(() => evalBoth('a(?=b)b', 'ab')).toThrow(RulesCompileError);
  });
});
