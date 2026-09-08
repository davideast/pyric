import { describe, expect, it } from 'bun:test';
import { parsePathSegments, canonicalizePath } from 'pyric/sandbox/internal';

describe('Zero-Regex Structural Path Canonicalization (pyric/sandbox/internal)', () => {
  it('collapses consecutive internal, leading, and trailing slashes without regexes', () => {
    expect(parsePathSegments('///users//alice///orders//')).toEqual(['users', 'alice', 'orders']);
    expect(canonicalizePath('///users//alice///orders//')).toBe('users/alice/orders');
  });

  it('handles root and empty paths cleanly', () => {
    expect(parsePathSegments('/')).toEqual([]);
    expect(canonicalizePath('/')).toBe('');
    expect(canonicalizePath('   ///   ')).toBe('');
  });

  it('explicitly rejects relative traversal segments (. and ..)', () => {
    expect(() => parsePathSegments('users/../admin')).toThrow(/Invalid relative path segment/);
    expect(() => canonicalizePath('users/./profile')).toThrow(/Invalid relative path segment/);
  });
});
