/** Emulator-grade custom-claims validation — message parity with
 *  firebase-tools-ui's CustomAttributes control. */
import { describe, test, expect } from 'bun:test';
import {
  validateSerializedClaims,
  FORBIDDEN_CUSTOM_CLAIMS,
  CUSTOM_CLAIMS_MAX_LENGTH,
} from '../../../src/auth/index.js';

describe('validateSerializedClaims', () => {
  test('empty / whitespace input is valid with undefined claims', () => {
    expect(validateSerializedClaims('')).toEqual({ ok: true, claims: undefined });
    expect(validateSerializedClaims('   \n ')).toEqual({ ok: true, claims: undefined });
  });

  test('a valid JSON object parses', () => {
    const r = validateSerializedClaims('{"role":"admin","level":3}');
    expect(r).toEqual({ ok: true, claims: { role: 'admin', level: 3 } });
  });

  test('invalid JSON → emulator message', () => {
    const r = validateSerializedClaims('{role: admin');
    expect(r).toEqual({ ok: false, message: 'Custom claims must be a valid JSON object' });
  });

  test('non-object JSON (array, string, number, null) → emulator message', () => {
    for (const text of ['[1,2]', '"admin"', '42', 'null', 'true']) {
      expect(validateSerializedClaims(text)).toEqual({
        ok: false,
        message: 'Custom claims must be a valid JSON object',
      });
    }
  });

  test('over 1000 characters → emulator message', () => {
    const big = `{"k":"${'x'.repeat(CUSTOM_CLAIMS_MAX_LENGTH)}"}`;
    expect(validateSerializedClaims(big)).toEqual({
      ok: false,
      message: 'Custom claims length must not exceed 1000 characters',
    });
  });

  test('every forbidden key is rejected with its name in the message', () => {
    for (const key of FORBIDDEN_CUSTOM_CLAIMS) {
      expect(validateSerializedClaims(`{"${key}": 1}`)).toEqual({
        ok: false,
        message: `Custom claims must not have forbidden key: ${key}`,
      });
    }
  });

  test('forbidden keys nested deeper are allowed (only top-level is reserved)', () => {
    const r = validateSerializedClaims('{"meta":{"sub":"ok"}}');
    expect(r.ok).toBe(true);
  });
});
