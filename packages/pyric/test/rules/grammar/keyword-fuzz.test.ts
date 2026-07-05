/**
 * Keyword boundary fuzz tests — converted from bug bash (122 assertions).
 * Verifies that identifiers containing keywords (is, in, true, false, null,
 * return, if, let) parse correctly, and that keywords in member access and
 * method call positions work.
 */
import { describe, test, expect } from 'bun:test';
import { parseExpression } from '../../../src/rules/grammar/FirestoreParser.js';

function valid(input: string) { expect(parseExpression(input).valid).toBe(true); }
function invalid(input: string) { expect(parseExpression(input).valid).toBe(false); }

describe('Keyword Boundary Fuzz', () => {
  describe('identifiers starting with keywords', () => {
    test('isAdmin', () => valid('isAdmin'));
    test('isOwner', () => valid('isOwner'));
    test('is_valid', () => valid('is_valid'));
    test('island', () => valid('island'));
    test('isolate', () => valid('isolate'));
    test('isBool', () => valid('isBool'));
    test('isString', () => valid('isString'));
    test('internal', () => valid('internal'));
    test('index', () => valid('index'));
    test('info', () => valid('info'));
    test('inbound', () => valid('inbound'));
    test('instruction', () => valid('instruction'));
    test('into', () => valid('into'));
    test('input', () => valid('input'));
    test('innerHTML', () => valid('innerHTML'));
    test('integer', () => valid('integer'));
    test('interface', () => valid('interface'));
    test('inline', () => valid('inline'));
    test('infinity', () => valid('infinity'));
    test('initial', () => valid('initial'));
    test('insert', () => valid('insert'));
    test('inspect', () => valid('inspect'));
    test('trueValue', () => valid('trueValue'));
    test('trueish', () => valid('trueish'));
    test('falsePositive', () => valid('falsePositive'));
    test('nullify', () => valid('nullify'));
    test('nullable', () => valid('nullable'));
    test('null_check', () => valid('null_check'));
    test('returnValue', () => valid('returnValue'));
    test('returning', () => valid('returning'));
    test('letterCount', () => valid('letterCount'));
    test('ifCondition', () => valid('ifCondition'));
  });

  describe('identifiers ending with keywords', () => {
    test('login', () => valid('login'));
    test('within', () => valid('within'));
    test('plugin', () => valid('plugin'));
    test('begin', () => valid('begin'));
    test('herein', () => valid('herein'));
    test('admin', () => valid('admin'));
    test('origin', () => valid('origin'));
    test('cabin', () => valid('cabin'));
    test('robin', () => valid('robin'));
    test('satin', () => valid('satin'));
    test('raisin', () => valid('raisin'));
    test('basin', () => valid('basin'));
    test('thinktrue', () => valid('thinktrue'));
    test('setfalse', () => valid('setfalse'));
    test('isnull', () => valid('isnull'));
    test('whatif', () => valid('whatif'));
  });

  describe('identifiers containing keywords', () => {
    test('isInList', () => valid('isInList'));
    test('isInMap', () => valid('isInMap'));
    test('containsNull', () => valid('containsNull'));
    test('returnTrue', () => valid('returnTrue'));
    test('trueOrFalse', () => valid('trueOrFalse'));
  });

  describe('bare keywords must not be identifiers', () => {
    test('is (invalid as standalone expression)', () => invalid('is'));
    test('in (invalid as standalone expression)', () => invalid('in'));
    test('true (literal, not identifier)', () => valid('true'));
    test('false (literal, not identifier)', () => valid('false'));
    test('null (literal, not identifier)', () => valid('null'));
  });

  describe('keywords used correctly in expressions', () => {
    test('value is string', () => valid('value is string'));
    test('value is int', () => valid('value is int'));
    test("'key' in data", () => valid("'key' in data"));
    test("x in ['a', 'b']", () => valid("x in ['a', 'b']"));
    test('within == true', () => valid('within == true'));
    test('island is string', () => valid('island is string'));
    test('isAdmin is bool', () => valid('isAdmin is bool'));
    test("login in ['a']", () => valid("login in ['a']"));
    test('admin in roles', () => valid('admin in roles'));
  });

  describe('is/in with chained member access', () => {
    test('data.field is string', () => valid('data.field is string'));
    test('data.field is timestamp', () => valid('data.field is timestamp'));
    test('request.resource.data.x is list', () => valid('request.resource.data.x is list'));
    test('"x" in request.resource.data', () => valid('"x" in request.resource.data'));
    test('field in data.keys()', () => valid('field in data.keys()'));
  });

  describe('all type names after is', () => {
    for (const t of ['string', 'int', 'float', 'number', 'bool', 'list', 'map', 'timestamp', 'path', 'bytes', 'duration']) {
      test(`x is ${t}`, () => valid(`x is ${t}`));
    }
  });

  describe('strings containing keywords', () => {
    test("'is'", () => valid("'is'"));
    test("'in'", () => valid("'in'"));
    test("'true'", () => valid("'true'"));
    test("'false'", () => valid("'false'"));
    test("'null'", () => valid("'null'"));
    test("'return'", () => valid("'return'"));
    test("'if'", () => valid("'if'"));
    test("'is string'", () => valid("'is string'"));
    test("regex chars in string", () => valid("'[a-z]+@[a-z]+\\\\.com'"));
  });

  describe('keyword-named methods', () => {
    test('.get()', () => valid('data.get("key", null)'));
    test('.list()', () => valid('data.list()'));
    test('.is()', () => valid('data.is()'));
    test('.in()', () => valid('data.in()'));
    test('.delete()', () => valid('data.delete()'));
    test('.update()', () => valid('data.update()'));
    test('.create()', () => valid('data.create()'));
    test('.read()', () => valid('data.read()'));
    test('.write()', () => valid('data.write()'));
    test('.return()', () => valid('data.return()'));
    test('.if()', () => valid('data.if()'));
    test('.true()', () => valid('data.true()'));
    test('.false()', () => valid('data.false()'));
    test('.null()', () => valid('data.null()'));
    test('.let()', () => valid('data.let()'));
  });

  describe('keyword-named member access', () => {
    test('.is', () => valid('data.is'));
    test('.in', () => valid('data.in'));
    test('.true', () => valid('data.true'));
    test('.false', () => valid('data.false'));
    test('.null', () => valid('data.null'));
    test('.return', () => valid('data.return'));
    test('.if', () => valid('data.if'));
    test('.let', () => valid('data.let'));
  });

  describe('complex combinations', () => {
    test('isAdmin && value is string', () => valid('isAdmin && value is string'));
    test("login in list && isValid is bool", () => valid("login in ['a'] && isValid is bool"));
    test('within in data && island is string', () => valid('within in data && island is string'));
    test('data.isValid is bool', () => valid('data.isValid is bool'));
    test('data.inList in items', () => valid('data.inList in items'));
    test('x.is.in.true.false.null (chained keyword members)', () => valid('x.is.in.true.false.null'));
    test('data.is.in.if.let.return', () => valid('data.is.in.if.let.return'));
  });
});
