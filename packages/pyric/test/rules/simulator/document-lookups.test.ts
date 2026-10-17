import { describe, expect, test } from 'bun:test';
import {
  makeGetResource,
  normalizeDocumentPath,
  resolveExists,
  resolveGet,
} from '../../../src/rules/simulator/document-lookups.js';
import type { SimulationContext } from '../../../src/rules/simulator/evaluation-context.js';
import { EvalError } from '../../../src/rules/simulator/eval-error.js';
import { RulesFloat } from '../../../src/rules/simulator/wrappers/float.js';

describe('document lookups', () => {
  test('normalizes canonical document paths', () => {
    expect(normalizeDocumentPath('/databases/$(database)/documents/users/alice')).toBe('users/alice');
  });

  test('keeps serializable function mocks identityless', () => {
    const path = 'users/alice';
    const context = {
      mockDocuments: new Map([[path, { role: 'admin' }]]),
      identitylessFunctionMocks: new Set([path]),
    } as unknown as SimulationContext;

    expect(resolveGet(path, context)).toEqual({ data: { role: 'admin' } });
  });

  test('revives non-integer JS numbers to RulesFloat in resolveGet, resolveExists, and makeGetResource (FS-MET-3)', () => {
    const path = 'metrics/m1';
    const lazyPath = 'metrics/m2';
    const context = {
      mockDocuments: new Map([[path, { ratio: 1.5, count: 3, nested: { score: 2.25 } }]]),
      getDoc: (p: string) => (p === lazyPath ? { ratio: 0.75, count: 4 } : undefined),
      identitylessFunctionMocks: new Set<string>(),
    } as unknown as SimulationContext;

    const current = resolveGet(path, context) as {
      data: { ratio: unknown; count: unknown; nested: { score: unknown } };
    };
    expect(current.data.ratio).toBeInstanceOf(RulesFloat);
    expect((current.data.ratio as RulesFloat).valueOf()).toBe(1.5);
    expect(current.data.count).toBe(3);
    expect(current.data.nested.score).toBeInstanceOf(RulesFloat);

    expect(resolveExists(lazyPath, context)).toBe(true);
    const lazy = resolveGet(lazyPath, context) as {
      data: { ratio: unknown; count: unknown };
    };
    expect(lazy.data.ratio).toBeInstanceOf(RulesFloat);
    expect((lazy.data.ratio as RulesFloat).valueOf()).toBe(0.75);
    expect(lazy.data.count).toBe(4);

    const afterResource = makeGetResource(path, { ratio: 3.5, count: 7 }) as {
      data: { ratio: unknown; count: unknown };
    };
    expect(afterResource.data.ratio).toBeInstanceOf(RulesFloat);
    expect((afterResource.data.ratio as RulesFloat).valueOf()).toBe(3.5);
    expect(afterResource.data.count).toBe(7);
  });

  test('rejects odd-segment collection paths and {capture} segments in resolveExists and resolveGet (FS-SIM-12, FS-FUZ-6)', () => {
    const context = {
      mockDocuments: new Map([
        ['users/alice', { role: 'admin' }],
        ['users/{uid}', { role: 'admin' }],
      ]),
    } as unknown as SimulationContext;

    expect(() => resolveExists('/databases/(default)/documents/users', context)).toThrow(EvalError);
    expect(() => resolveExists('/databases/(default)/documents', context)).toThrow(EvalError);
    expect(() => resolveGet('/databases/(default)/documents/users', context)).toThrow(EvalError);
    expect(() => resolveExists('/databases/(default)/documents/users/{uid}', context)).toThrow(EvalError);
    expect(() => resolveGet('/databases/(default)/documents/users/{uid}', context)).toThrow(EvalError);
  });
});
