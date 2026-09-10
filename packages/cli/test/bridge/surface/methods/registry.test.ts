/**
 * The loaded surface: the manifest's records stamped with the key their path
 * carries, in the lookups every derived surface joins on. A record whose own
 * `tool` or `method` field disagrees with the path it is filed under is
 * refused, because it would be reachable under two names and auditable under
 * neither.
 */
import { describe, expect, it } from 'bun:test';

import {
  CANONICAL_OPERATIONS,
  METHODS,
  METHODS_BY_KEY,
  methodByKey,
  methodByName,
  toolByName,
  TOOLS,
} from '../../../../src/bridge/surface/methods/registry.js';

describe('TOOLS', () => {
  it('loads every service tool, ordered by its declared order', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toEqual([
      'firestore',
      'database',
      'storage',
      'auth',
      'messaging',
      'functions',
      'rules',
      'sandbox',
      'assurance',
    ]);
  });

  it('gives every tool at least one method', () => {
    for (const tool of TOOLS) expect(tool.methods.length).toBeGreaterThan(0);
  });
});

describe('METHODS and METHODS_BY_KEY', () => {
  it('flattens every tool method, in tool order then manifest order', () => {
    expect(METHODS.length).toBe(TOOLS.reduce((total, tool) => total + tool.methods.length, 0));
  });

  it('keys every method by <tool>.<method>', () => {
    for (const method of METHODS) {
      expect(METHODS_BY_KEY.get(method.key)).toBe(method);
    }
  });

  it('stamps each method the key its directory and filename carry', () => {
    const firestoreGetDoc = METHODS_BY_KEY.get('firestore.getDoc');
    expect(firestoreGetDoc?.tool).toBe('firestore');
    expect(firestoreGetDoc?.method).toBe('getDoc');
  });
});

describe('toolByName, methodByName, methodByKey', () => {
  it('finds a tool by name, and undefined for an unknown one', () => {
    expect(toolByName('firestore')?.name).toBe('firestore');
    expect(toolByName('spanner')).toBeUndefined();
  });

  it('finds a method of a tool by name, excluding describe', () => {
    const firestore = toolByName('firestore')!;
    expect(methodByName(firestore, 'getDoc')?.key).toBe('firestore.getDoc');
    expect(methodByName(firestore, 'describe')).toBeUndefined();
  });

  it('finds a method by its key, and throws for an unknown one', () => {
    expect(methodByKey('firestore.getDoc').method).toBe('getDoc');
    expect(() => methodByKey('firestore.notAMethod')).toThrow(
      "unknown surface method 'firestore.notAMethod'",
    );
  });
});

describe('CANONICAL_OPERATIONS', () => {
  it('collects every operation id every method reaches, sorted, with no duplicates', () => {
    expect([...CANONICAL_OPERATIONS]).toEqual([...CANONICAL_OPERATIONS].sort());
    expect(new Set(CANONICAL_OPERATIONS).size).toBe(CANONICAL_OPERATIONS.length);
    expect(CANONICAL_OPERATIONS).toContain('get_firestore_document');
  });
});
