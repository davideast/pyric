import { describe, expect, test } from 'bun:test';
import { storageDecision } from '../../src/storage-stdlib-real-objects.ts';

describe('storage stdlib real object support', () => {
  test('normalizes allowed and denied Storage outcomes', () => {
    expect(storageDecision()).toEqual({ allowed: true });
    const denied = Object.assign(new Error('denied'), { code: 'storage/unauthorized' });
    expect(storageDecision(denied)).toEqual({
      allowed: false,
      code: 'storage/unauthorized',
      message: 'denied',
    });
  });
});
