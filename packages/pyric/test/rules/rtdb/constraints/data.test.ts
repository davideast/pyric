import { describe, test, expect } from 'bun:test';
import {
  dataVal, newDataVal, dataExists, newDataExists,
  newDataIs, dataParentVal, newDataParentVal, newDataParentExists,
  eq, neq, gt, lte, AUTH_UID,
} from '../../../../src/rules/rtdb/constraints/data.js';

describe('Data template helpers', () => {
  // --- Value access ---
  describe('dataVal', () => {
    test('no path → data.val()', () => {
      expect(dataVal()).toBe('data.val()');
    });
    test('with path → data.child("field").val()', () => {
      expect(dataVal('status')).toBe('data.child("status").val()');
    });
  });

  describe('newDataVal', () => {
    test('no path → newData.val()', () => {
      expect(newDataVal()).toBe('newData.val()');
    });
    test('with path → newData.child("field").val()', () => {
      expect(newDataVal('host')).toBe('newData.child("host").val()');
    });
  });

  // --- Existence ---
  describe('dataExists', () => {
    test('no path → data.exists()', () => {
      expect(dataExists()).toBe('data.exists()');
    });
    test('with path → data.child("field").exists()', () => {
      expect(dataExists('guest')).toBe('data.child("guest").exists()');
    });
  });

  describe('newDataExists', () => {
    test('no path → newData.exists()', () => {
      expect(newDataExists()).toBe('newData.exists()');
    });
    test('with path → newData.child("field").exists()', () => {
      expect(newDataExists('winner')).toBe('newData.child("winner").exists()');
    });
  });

  // --- Type checks ---
  describe('newDataIs', () => {
    test('String', () => expect(newDataIs('String')).toBe('newData.isString()'));
    test('Number', () => expect(newDataIs('Number')).toBe('newData.isNumber()'));
    test('Boolean', () => expect(newDataIs('Boolean')).toBe('newData.isBoolean()'));
  });

  // --- Parent navigation ---
  describe('dataParentVal', () => {
    test('depth 1', () => {
      expect(dataParentVal(1, 'field')).toBe('data.parent().child("field").val()');
    });
    test('depth 2', () => {
      expect(dataParentVal(2, 'currentTurn')).toBe('data.parent().parent().child("currentTurn").val()');
    });
  });

  describe('newDataParentVal', () => {
    test('depth 1', () => {
      expect(newDataParentVal(1, 'xWins')).toBe('newData.parent().child("xWins").val()');
    });
  });

  describe('newDataParentExists', () => {
    test('depth 1', () => {
      expect(newDataParentExists(1, 'winner')).toBe('newData.parent().child("winner").exists()');
    });
  });

  // --- Comparisons ---
  describe('eq', () => {
    test('string right → quoted', () => {
      expect(eq(dataVal(), 'X')).toBe('data.val() === "X"');
    });
    test('number right → unquoted', () => {
      expect(eq(newDataVal(), 0)).toBe('newData.val() === 0');
    });
    test('boolean right → unquoted', () => {
      expect(eq(newDataVal(), true)).toBe('newData.val() === true');
    });
    test('null right → unquoted', () => {
      expect(eq(newDataVal(), null)).toBe('newData.val() === null');
    });
    test('segment right → runtime reference', () => {
      expect(eq(newDataVal(), AUTH_UID)).toBe('newData.val() === auth.uid');
    });
    test('with child path', () => {
      expect(eq(dataVal('status'), 'open')).toBe('data.child("status").val() === "open"');
    });
    test('parent val with string', () => {
      expect(eq(dataParentVal(2, 'currentTurn'), 'X')).toBe('data.parent().parent().child("currentTurn").val() === "X"');
    });
    test('newData parent val with boolean', () => {
      expect(eq(newDataParentVal(1, 'xWins'), true)).toBe('newData.parent().child("xWins").val() === true');
    });
  });

  describe('neq', () => {
    test('string right', () => {
      expect(neq(newDataVal(), 'X')).toBe('newData.val() !== "X"');
    });
    test('boolean right', () => {
      expect(neq(newDataVal(), true)).toBe('newData.val() !== true');
    });
    test('null right', () => {
      expect(neq(newDataParentVal(1, 'winner'), null)).toBe('newData.parent().child("winner").val() !== null');
    });
    test('segment right (AUTH_UID)', () => {
      expect(neq(dataVal('host'), AUTH_UID)).toBe('data.child("host").val() !== auth.uid');
    });
  });

  describe('gt', () => {
    test('numeric', () => {
      expect(gt(newDataVal(), 0)).toBe('newData.val() > 0');
    });
  });

  describe('lte', () => {
    test('numeric', () => {
      expect(lte(newDataVal(), 200)).toBe('newData.val() <= 200');
    });
  });

  // --- AUTH_UID ---
  describe('AUTH_UID', () => {
    test('is a segment marker', () => {
      expect(AUTH_UID).toEqual({ $: 'auth.uid' });
    });
  });
});
