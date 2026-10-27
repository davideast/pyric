import { describe, expect, test } from 'bun:test';
import { validateReferencePath, validateUpdatePaths } from '../../src/database/writable-path.js';

const KEY_SUFFIX = 'Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"';
const plainSegments = (path: string): string[] => path.split('/').filter(Boolean);

describe('validateUpdatePaths', () => {
  test('the default splitter refuses what the sandbox refused before', () => {
    expect(() => validateUpdatePaths({ 'a.b': 1 })).toThrow(
      `update failed: values argument contains an invalid key (a.b) in path /a.b. ${KEY_SUFFIX}`,
    );
    expect(() => validateUpdatePaths({ a: 1, 'a/b': 2 })).toThrow(
      'update failed: values argument contains a path /a that is ancestor of another path /a/b',
    );
    expect(() => validateUpdatePaths(JSON.parse('{"__proto__":1}') as Record<string, unknown>)).toThrow(
      "Invalid RTDB path segment '__proto__'",
    );
    expect(() => validateUpdatePaths({ a: 1, 'b/.priority': 2, 'c/d': 3 })).not.toThrow();
  });

  test('a plain splitter accepts __proto__ as a key and still refuses overlap and invalid keys', () => {
    const proto = JSON.parse('{"__proto__":1, "constructor/x":2}') as Record<string, unknown>;
    expect(() => validateUpdatePaths(proto, plainSegments)).not.toThrow();
    expect(() => validateUpdatePaths({ b: 1, '/b/': 2 }, plainSegments)).toThrow('ancestor of another path /b');
    expect(() => validateUpdatePaths({ 'a#': 1 }, plainSegments)).toThrow('invalid key (a#)');
  });
});

describe('validateUpdatePaths at the root', () => {
  // The SDK's pathContains reads the empty path as an ancestor of every path.
  test('a root key and any other key overlap', () => {
    expect(() => validateUpdatePaths({ '/': { x: 1 }, x: 2 })).toThrow(
      'update failed: values argument contains a path / that is ancestor of another path /x',
    );
    expect(() => validateUpdatePaths({ '': 1, 'a/b': 2 }, plainSegments)).toThrow('contains a path / that is ancestor of another path /a/b');
    expect(() => validateUpdatePaths({ '/': { x: 1 } })).not.toThrow();
  });
});

describe('validateReferencePath control characters', () => {
  // The SDK's path regex refuses U+0000 to U+001F and U+007F.
  for (const ch of ['\u0000', '\u0001', '\u001f', '\u007f']) {
    test(`refuses U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`, () => {
      expect(() => validateReferencePath(`/a${ch}b`, false)).toThrow('child failed: path argument was an invalid path');
    });
  }
  test('accepts a tab-free ordinary path and characters above U+007F', () => {
    expect(() => validateReferencePath('/a b/é/\u0080', false)).not.toThrow();
  });
});

describe('validateReferencePath', () => {
  test('refuses the characters the SDK refuses, outside a leading /.info', () => {
    expect(() => validateReferencePath('/a.b', false)).toThrow('child failed: path argument was an invalid path = "/a.b".');
    expect(() => validateReferencePath('', false)).toThrow('invalid path = ""');
    expect(() => validateReferencePath('', true)).not.toThrow();
    expect(() => validateReferencePath('/.info/connected', false)).not.toThrow();
  });
});
