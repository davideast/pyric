import { describe, it, expect } from 'bun:test';
import { instanceSlug } from '../../src/shell/instance-slug.js';

describe('instanceSlug', () => {
  it('is deterministic', () => {
    expect(instanceSlug('abc-123-def')).toBe(instanceSlug('abc-123-def'));
  });

  it('is the adjective-animal shape; empty for an empty id', () => {
    expect(instanceSlug('')).toBe('');
    expect(instanceSlug('x')).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it('varies across ids (so two instances usually read differently)', () => {
    const slugs = new Set(Array.from({ length: 20 }, (_, i) => instanceSlug(`id-${i}-${i * 7}`)));
    expect(slugs.size).toBeGreaterThan(1);
  });
});
