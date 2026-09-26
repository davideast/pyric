import { describe, test, expect } from 'bun:test';
import { typeMatches } from '../../../src/storage/sandbox/rules-operators.js';
import { Path } from '../../../src/rules/simulator/wrappers/path.js';
import { LatLng } from '../../../src/rules/simulator/wrappers/latlng.js';

describe('07-storage-type-match-latlng-path-and-null', () => {
  test('typeMatches supports null type check', () => {
    expect(typeMatches(null, 'null')).toBe(true);
    expect(typeMatches('not null', 'null')).toBe(false);
    expect(typeMatches(undefined, 'null')).toBe(false);
  });

  test('typeMatches supports path type check', () => {
    const p = Path.fromString('users/alice');
    expect(typeMatches(p, 'path')).toBe(true);
    expect(typeMatches('users/alice', 'path')).toBe(false);
  });

  test('typeMatches supports latlng type check', () => {
    const ll = new LatLng(37.7749, -122.4194);
    expect(typeMatches(ll, 'latlng')).toBe(true);
    expect(typeMatches({ latitude: 37.7749, longitude: -122.4194 }, 'latlng')).toBe(false);
  });
});
