import { describe, expect, it } from 'bun:test';
import definition from '../../../src/examples/firestore-first-write/definition';

describe('firestore-first-write definition', () => {
  it('declares the Firestore setup its run function needs', () => {
    expect(definition.service).toBe('firestore');
    expect(definition.firestore.rules).toContain('service cloud.firestore');
  });
});
