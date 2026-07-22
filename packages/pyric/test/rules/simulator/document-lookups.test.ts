import { describe, expect, test } from 'bun:test';
import { normalizeDocumentPath, resolveGet } from '../../../src/rules/simulator/document-lookups.js';
import type { SimulationContext } from '../../../src/rules/simulator/evaluation-context.js';

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
});
