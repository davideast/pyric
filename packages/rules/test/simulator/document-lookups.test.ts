import { describe, expect, test } from 'bun:test';
import {
  EXISTS_ONLY_DOC,
  makeGetResource,
  normalizeDocumentPath,
  resolveExists,
  resolveGet,
} from '../../src/simulator/document-lookups.js';
import type { SimulationContext } from '../../src/simulator/evaluation-context.js';
import { EvalError } from '../../src/simulator/eval-error.js';
import { TraceRecorder } from '../../src/simulator/trace-recorder.js';
import { RulesFloat } from '../../src/simulator/wrappers/float.js';

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

  test('passes lookup kind and active TraceRecorder to getDoc and supports EXISTS_ONLY_DOC without caching fake get() data', () => {
    const trace = new TraceRecorder();
    const calls: Array<{ path: string; kind?: 'get' | 'exists'; sameTrace: boolean }> = [];
    const context = {
      mockDocuments: new Map<string, Record<string, unknown>>(),
      trace,
      getDoc: (path: string, lookup?: { kind: 'get' | 'exists'; trace?: TraceRecorder }) => {
        calls.push({ path, kind: lookup?.kind, sameTrace: lookup?.trace === trace });
        if (lookup?.kind === 'exists') return EXISTS_ONLY_DOC as Record<string, unknown>;
        return null;
      },
    } as unknown as SimulationContext;

    expect(resolveExists('/databases/(default)/documents/projects/partial-1', context)).toBe(true);
    expect(() => resolveGet('/databases/(default)/documents/projects/partial-1', context)).toThrow(EvalError);
    expect(calls).toEqual([
      { path: 'projects/partial-1', kind: 'exists', sameTrace: true },
      { path: 'projects/partial-1', kind: 'get', sameTrace: true },
    ]);
  });

  test('rejects non-default database lookup paths explicitly including degenerate 1-segment collection paths', () => {
    const context = {
      mockDocuments: new Map([
        ['databases/analytics/documents/orgs', { name: 'spoofed' }],
        ['orgs/org-1', { name: 'default-org' }],
      ]),
    } as unknown as SimulationContext;

    expect(() => resolveExists('/databases/analytics/documents/orgs', context)).toThrow(EvalError);
    expect(() => resolveGet('/databases/analytics/documents/orgs', context)).toThrow(EvalError);
    expect(() => resolveExists('/databases/analytics/documents/orgs/org-1', context)).toThrow(EvalError);
    expect(() => resolveGet('/databases/analytics/documents/orgs/org-1', context)).toThrow(EvalError);
    expect(() => resolveExists('/databases/analytics/documents', context)).toThrow(EvalError);

    // A subcollection literally named `databases/...` inside `(default)` still resolves normally.
    const defaultNestedContext = {
      mockDocuments: new Map([
        ['databases/analytics/documents/orgs', { ok: true }],
      ]),
    } as unknown as SimulationContext;
    expect(
      resolveExists('/databases/(default)/documents/databases/analytics/documents/orgs', defaultNestedContext),
    ).toBe(true);
  });

  test('does not strip /databases/(default)/documents without a segment boundary and rejects malformed /databases/... lookup paths', () => {
    expect(normalizeDocumentPath('/databases/(default)/documents')).toBe('');
    expect(normalizeDocumentPath('/databases/(default)/documents/')).toBe('');
    expect(normalizeDocumentPath('/databases/(default)/documents/admins/u1')).toBe('admins/u1');
    expect(normalizeDocumentPath('/databases/(default)/documentsadmins/u1')).toBe(
      'databases/(default)/documentsadmins/u1',
    );
    expect(normalizeDocumentPath('/databases/(default)/documents_extra/u1')).toBe(
      'databases/(default)/documents_extra/u1',
    );
    expect(normalizeDocumentPath('/databases/analytics/documents/orgs/o1', 'analytics')).toBe('orgs/o1');
    expect(normalizeDocumentPath('/databases/analytics/documents', 'analytics')).toBe('');

    const context = {
      mockDocuments: new Map([
        ['admins/u1', { isAdmin: true }],
        ['databases/(default)/documentsadmins/u1', { isAdmin: true }],
        ['databases/(default)', { isAdmin: true }],
      ]),
    } as unknown as SimulationContext;

    expect(() => resolveExists('/databases/(default)/documentsadmins/u1', context)).toThrow(EvalError);
    expect(() => resolveGet('/databases/(default)/documentsadmins/u1', context)).toThrow(EvalError);
    expect(() => resolveExists('/databases/(default)/documents_extra/u1', context)).toThrow(EvalError);
    expect(() => resolveGet('/databases/(default)/documents_extra/u1', context)).toThrow(EvalError);
    expect(() => resolveExists('/databases/(default)', context)).toThrow(EvalError);
    expect(() => resolveGet('/databases/(default)', context)).toThrow(EvalError);
    expect(() => resolveExists('/databases', context)).toThrow(EvalError);
    expect(() => resolveExists('/databases/analytics/documentsadmins/u1', context)).toThrow(EvalError);
    expect(() => resolveExists('databases/(default)/documents_extra/u1', context)).toThrow(EvalError);
    expect(() => resolveGet('databases/(default)/documents_extra/u1', context)).toThrow(EvalError);
    expect(() => resolveExists('/databases/./(default)/documents/admins', context)).toThrow(EvalError);
    expect(() => resolveGet('/databases/./(default)/documents/admins', context)).toThrow(EvalError);
    expect(() => resolveExists('/databases//(default)//documents/admins', context)).toThrow(EvalError);

    expect(normalizeDocumentPath('/databases//(default)//documents/admins')).toBe('admins');
    const namedGetResource = makeGetResource('orgs/o1', { name: 'acme' }, 'analytics');
    expect(String(namedGetResource.__name__)).toBe('/databases/analytics/documents/orgs/o1');
  });
});
