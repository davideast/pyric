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
    expect(source).toContain('"size": ["bytes", "list", "map", "set", "string"]');
    expect(source).toContain('firestore: ["exists", "get"]');
    expect(source).toContain('"request.resource.contentType"');
    expect(source).toContain(
      'FIRESTORE_DIRECT_FUNCTIONS = ["exists", "existsAfter", "float", "get", "getAfter", "int", "path", "string"]',
    );
    expect(source).not.toContain('"request.resource.name"');
    expect(source).not.toContain('isInfinite');
  });

  test('emits accepted conversion functions as direct calls, not as a namespace', () => {
    const source = renderRulesModuleCapabilities();

    expect(source).not.toContain('cast:');
    expect(source).not.toContain('"bool"');
    expect(source).not.toContain('"debug"');
  });
});
