import { describe, expect, test } from 'bun:test';
import { renderRulesModuleCapabilities } from '../../src/rules-module-capabilities.ts';

describe('rules module capability projection', () => {
  test('generates accepted Firestore and Storage vocabularies from their inventories', () => {
    const source = renderRulesModuleCapabilities();

    expect(source).toContain('FIRESTORE_NAMESPACE_METHODS');
    expect(source).toContain('STORAGE_NAMESPACE_METHODS');
    expect(source).toContain('STORAGE_BINDING_PATHS');
    expect(source).toContain('STORAGE_METHODS');
    expect(source).toContain('STORAGE_METHOD_RECEIVER_TYPES');
    expect(source).toContain('"matches": ["string"]');
    expect(source).toContain('"size": ["list", "map", "string"]');
    expect(source).toContain('firestore: ["exists", "get"]');
    expect(source).toContain('"request.resource.contentType"');
    expect(source).toContain('FIRESTORE_DIRECT_FUNCTIONS = ["exists", "get", "getAfter"]');
    expect(source).not.toContain('"request.resource.name"');
    expect(source).not.toContain('isInfinite');
  });
});
