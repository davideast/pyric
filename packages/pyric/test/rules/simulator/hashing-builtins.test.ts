import { describe, expect, test } from 'bun:test';
import { evaluateHashingMethod } from '../../../src/rules/simulator/hashing-builtins.js';
import { Bytes } from '../../../src/rules/simulator/wrappers/bytes.js';

describe('hashing built-ins', () => {
  test('hashes string input to the production byte representation', () => {
    const digest = evaluateHashingMethod('sha256', ['abc']) as Bytes;
    expect(digest.toHexString()).toBe('BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD');
  });
});
