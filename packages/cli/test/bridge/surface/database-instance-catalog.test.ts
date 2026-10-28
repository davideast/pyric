/**
 * The catalog a `database` method resolves an instance name against.
 */
import { describe, expect, it } from 'bun:test';

import { databaseInstanceCatalog, distinctNames } from '../../../src/bridge/surface/database-instance-catalog.js';

describe('databaseInstanceCatalog', () => {
  it('selects the default, a known name, or nothing', () => {
    const catalog = databaseInstanceCatalog({ defaultInstance: 'd', named: ['s'], pending: [] });
    expect(catalog.select('d')).toBeUndefined();
    expect(catalog.select('s')).toBe('s');
    expect(catalog.select('x')).toBeNull();
  });
});

describe('distinctNames', () => {
  it('keeps the first of each name, without the excluded one', () => {
    expect(distinctNames(['a', 'b', 'a', 'd'], 'd')).toEqual(['a', 'b']);
  });
});
