import { describe, test, expect } from 'bun:test';
import {
  dataVal, newDataVal, dataExists, newDataExists,
  newDataIs, dataParentVal, newDataParentVal, newDataParentExists,
  eq, neq, gt, lte, AUTH_UID, ref,
} from '../../../../src/rules/rtdb/constraints/data.js';
import { ref as constraintsRef } from '../../../../src/rules/rtdb/constraints/index.js';
import { ref as rulesRef } from '../../../../src/rules/index.js';
import { ref as internalRtdbRef } from '../../../../src/rules/internal/rtdb.js';

describe('Data template helpers', () => {
  // --- Value access ---
  describe('dataVal', () => {
    test('no path → data.val()', () => {
      expect(dataVal()).toBe('data.val()');
    });
    test("with path → data.child('field').val()", () => {
      expect(dataVal('status')).toBe("data.child('status').val()");
    });
  });

  describe('newDataVal', () => {
    test('no path → newData.val()', () => {
      expect(newDataVal()).toBe('newData.val()');
    });
    test("with path → newData.child('field').val()", () => {
      expect(newDataVal('host')).toBe("newData.child('host').val()");
    });
  });

  // --- Existence ---
  describe('dataExists', () => {
    test('no path → data.exists()', () => {
      expect(dataExists()).toBe('data.exists()');
    });
    test("with path → data.child('field').exists()", () => {
      expect(dataExists('guest')).toBe("data.child('guest').exists()");
    });
  });

  describe('newDataExists', () => {
    test('no path → newData.exists()', () => {
      expect(newDataExists()).toBe('newData.exists()');
    });
    test("with path → newData.child('field').exists()", () => {
      expect(newDataExists('winner')).toBe("newData.child('winner').exists()");
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
      expect(dataParentVal(1, 'field')).toBe("data.parent().child('field').val()");
    });
    test('depth 2', () => {
      expect(dataParentVal(2, 'currentTurn')).toBe("data.parent().parent().child('currentTurn').val()");
    });
  });

  describe('newDataParentVal', () => {
    test('depth 1', () => {
      expect(newDataParentVal(1, 'xWins')).toBe("newData.parent().child('xWins').val()");
    });
  });

  describe('newDataParentExists', () => {
    test('depth 1', () => {
      expect(newDataParentExists(1, 'winner')).toBe("newData.parent().child('winner').exists()");
    });
  });

  // --- Comparisons ---
  describe('eq', () => {
    test('string right → quoted', () => {
      expect(eq(dataVal(), 'X')).toBe("data.val() == 'X'");
    });
    test('number right → unquoted', () => {
      expect(eq(newDataVal(), 0)).toBe('newData.val() == 0');
    });
    test('boolean right → unquoted', () => {
      expect(eq(newDataVal(), true)).toBe('newData.val() == true');
    });
    test('null right → unquoted', () => {
      expect(eq(newDataVal(), null)).toBe('newData.val() == null');
    });
    test('segment right → runtime reference', () => {
      expect(eq(newDataVal(), AUTH_UID)).toBe('newData.val() == auth.uid');
    });
    test('with child path', () => {
      expect(eq(dataVal('status'), 'open')).toBe("data.child('status').val() == 'open'");
    });
    test('parent val with string', () => {
      expect(eq(dataParentVal(2, 'currentTurn'), 'X')).toBe("data.parent().parent().child('currentTurn').val() == 'X'");
    });
    test('newData parent val with boolean', () => {
      expect(eq(newDataParentVal(1, 'xWins'), true)).toBe("newData.parent().child('xWins').val() == true");
    });
  });

  describe('neq', () => {
    test('string right', () => {
      expect(neq(newDataVal(), 'X')).toBe("newData.val() != 'X'");
    });
    test('boolean right', () => {
      expect(neq(newDataVal(), true)).toBe('newData.val() != true');
    });
    test('null right', () => {
      expect(neq(newDataParentVal(1, 'winner'), null)).toBe("newData.parent().child('winner').val() != null");
    });
    test('segment right (AUTH_UID)', () => {
      expect(neq(dataVal('host'), AUTH_UID)).toBe("data.child('host').val() != auth.uid");
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

  // --- ref ---
  describe('ref', () => {
    test('wraps an expression as a segment marker and is re-exported across rule entrypoints', () => {
      expect(ref("data.child('author').val()")).toEqual({ $: "data.child('author').val()" });
      expect(constraintsRef).toBe(ref);
      expect(rulesRef).toBe(ref);
      expect(internalRtdbRef).toBe(ref);
    });

    test('emits unquoted runtime references in eq and neq', () => {
      expect(eq(newDataVal('author'), ref("data.child('author').val()"))).toBe(
        "newData.child('author').val() == data.child('author').val()",
      );
      expect(eq(dataVal('owner'), ref('$uid'))).toBe("data.child('owner').val() == $uid");
      expect(neq(newDataVal('owner'), ref('$uid'))).toBe("newData.child('owner').val() != $uid");
    });
  });

  // --- Quoted reference rejection ---
  describe('eq / neq reject strings that look like rule references', () => {
    test('rejects auth.uid passed as a string and suggests AUTH_UID / ref("auth.uid")', () => {
      expect(() => eq(dataVal('owner'), 'auth.uid')).toThrow(/auth\.uid/);
      expect(() => eq(dataVal('owner'), 'auth.uid')).toThrow(/AUTH_UID/);
      expect(() => eq(dataVal('owner'), 'auth.uid')).toThrow(/ref\("auth\.uid"\)/);
    });

    test('rejects RTDB expression roots, path variables, and now passed as strings', () => {
      expect(() => eq(newDataVal('author'), "data.child('author').val()")).toThrow(
        /ref\("data\.child\('author'\)\.val\(\)"\)/,
      );
      expect(() => neq(newDataVal('status'), 'newData.val()')).toThrow(/ref\("newData\.val\(\)"\)/);
      expect(() => eq(dataVal('role'), "root.child('admins').val()")).toThrow(
        /ref\("root\.child\('admins'\)\.val\(\)"\)/,
      );
      expect(() => eq(dataVal('limit'), 'query.limitToFirst')).toThrow(
        /ref\("query\.limitToFirst"\)/,
      );
      expect(() => eq(dataVal('owner'), "auth['uid']")).toThrow(/ref\("auth\['uid'\]"\)/);
      expect(() => eq(dataVal('owner'), '$uid')).toThrow(/ref\("\$uid"\)/);
      expect(() => neq(newDataVal('createdAt'), 'now')).toThrow(/ref\("now"\)/);
    });

    test('near misses: ordinary string literals are still quoted', () => {
      expect(eq(dataVal('status'), 'auth')).toBe("data.child('status').val() == 'auth'");
      expect(eq(dataVal('status'), 'data')).toBe("data.child('status').val() == 'data'");
      expect(eq(dataVal('status'), 'nowhere')).toBe("data.child('status').val() == 'nowhere'");
      expect(eq(dataVal('price'), '$100')).toBe("data.child('price').val() == '$100'");
      expect(eq(dataVal('symbol'), '$')).toBe("data.child('symbol').val() == '$'");
    });
  });
});
