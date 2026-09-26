import { describe, test, expect } from 'bun:test';
import { Bytes } from '../../../src/rules/simulator/wrappers/bytes.js';
import { EvalError } from '../../../src/rules/simulator/eval-error.js';

describe('02-bytes-fromhex-evalerror-and-hex-validation', () => {
  test('Bytes.fromHex throws EvalError on odd-length hex strings', () => {
    expect(() => Bytes.fromHex('123')).toThrow(EvalError);
  });

  test('Bytes.fromHex throws EvalError on non-hex characters', () => {
    expect(() => Bytes.fromHex('zz')).toThrow(EvalError);
    expect(() => Bytes.fromHex('1g')).toThrow(EvalError);
    expect(() => Bytes.fromHex('0x12')).toThrow(EvalError);
  });
});
