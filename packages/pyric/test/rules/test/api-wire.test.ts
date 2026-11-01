/**
 * The Rules Test API request `buildApiTestCase` builds is the request the
 * simulator evaluates (#1338). The forms production reads as typed values are
 * the ones captured in `fixtures/case-wire/captures.json`, which
 * `case-wire-capture.test.ts` checks this builder against.
 */
import { describe, expect, test } from 'bun:test';
import {
  bytes,
  duration,
  latlng,
  reference,
  timestamp,
  vector,
} from '../../../src/rules/index.js';
import { buildApiTestCase, normalizeDocPath, type TestCase } from '../../../src/rules/test/spec.js';
import { TestFirestoreRulesHandler } from '../../../src/rules/test/handler.js';

function wire(over: Partial<TestCase>) {
  const tc = { description: 'case', expectation: 'ALLOW', method: 'update', path: 'docs/d1', ...over } as TestCase;
  return buildApiTestCase(tc);
}

const EXISTING = { a: { x: 1, y: 2 }, keep: true };

describe('request.resource.data is the document the simulator projects (FS2-SIM-10)', () => {
  test('a merge set merges the case data into the existing document', () => {
    const built = wire({ resource: EXISTING, data: { a: { x: 9 } }, writeMode: { kind: 'set', merge: true } });
    expect(built.request.resource).toEqual({ data: { a: { x: 9, y: 2 }, keep: true } });
    expect(built.resource).toEqual({ data: EXISTING });
  });

  test('a replacing set sends the case data alone', () => {
    const built = wire({ resource: EXISTING, data: { a: { x: 9 } }, writeMode: { kind: 'set', merge: false } });
    expect(built.request.resource).toEqual({ data: { a: { x: 9 } } });
  });

  test('a dotted update patches the nested field', () => {
    const built = wire({ resource: EXISTING, data: { 'a.x': 9 }, writeMode: { kind: 'update' } });
    expect(built.request.resource).toEqual({ data: { a: { x: 9, y: 2 }, keep: true } });
  });

  test('without a writeMode the case data is the incoming document', () => {
    expect(wire({ resource: EXISTING, data: { b: 1 } }).request.resource).toEqual({ data: { b: 1 } });
  });

  test('a create or update with no data carries an empty document, as the simulator binds it', () => {
    expect(wire({ method: 'create' }).request.resource).toEqual({ data: {} });
    expect(wire({ method: 'get' }).request.resource).toBeUndefined();
  });
});

describe('one path form (FS2-CON-1)', () => {
  test('the full resource name is not prefixed twice', () => {
    expect(normalizeDocPath('/databases/(default)/documents/users/alice')).toBe('/databases/(default)/documents/users/alice');
    expect(normalizeDocPath('databases/(default)/documents/users/alice')).toBe('/databases/(default)/documents/users/alice');
    expect(wire({ path: '/databases/(default)/documents/docs/d1' }).request.path).toBe('/databases/(default)/documents/docs/d1');
  });

  test('a collection called databases is still a collection', () => {
    expect(normalizeDocPath('databases/d1')).toBe('/databases/(default)/documents/databases/d1');
  });
});

describe('value helpers in the form production reads (FS2-CON-5)', () => {
  test('timestamp, latlng, duration and reference', () => {
    const built = wire({
      method: 'create',
      data: {
        at: timestamp('2026-01-01T00:00:00.123456789Z'),
        loc: latlng(1.5, -2),
        ttl: duration(-1500, 'ms'),
        owner: reference('users/alice'),
        nested: { list: [timestamp(0)] },
      },
    });
    expect(built.request.resource).toEqual({
      data: {
        at: '2026-01-01T00:00:00.123000000Z',
        loc: { latitude: 1.5, longitude: -2 },
        ttl: '-1.500000000s',
        owner: '/databases/(default)/documents/users/alice',
        nested: { list: ['1970-01-01T00:00:00.000000000Z'] },
      },
    });
  });

  test('values in resource and in get() mocks are encoded too', () => {
    const built = wire({
      resource: { at: timestamp(0) },
      functionMocks: [{ function: 'get', path: 'cfg/c', result: { at: timestamp(0) } }],
    });
    expect(built.resource).toEqual({ data: { at: '1970-01-01T00:00:00.000000000Z' } });
    expect(built.functionMocks?.[0]?.result).toEqual({ value: { data: { at: '1970-01-01T00:00:00.000000000Z' } } });
  });

  test('a plain map with a __type key is sent as the map it is', () => {
    const at = { __type: 'timestamp', seconds: 1, nanos: 0 };
    expect(wire({ method: 'create', data: { at } }).request.resource).toEqual({ data: { at } });
  });

  test('bytes and vectors have no wire form and are refused, naming the field', () => {
    expect(() => wire({ method: 'create', data: { b: bytes('hi') } })).toThrow(/data\.b is a bytes value/);
    expect(() => wire({ method: 'create', data: { v: vector([1]) } })).toThrow(/data\.v is a vector value/);
  });
});

describe('a create case with resource is refused before the wire (FS2-CON-12)', () => {
  test('buildApiTestCase throws the reason', () => {
    expect(() => wire({ method: 'create', data: { x: 2 }, resource: { x: 1 } })).toThrow(
      "Case refused: a create case has no existing resource; use 'update' or remove 'resource'.",
    );
  });

  test('TestFirestoreRulesHandler refuses it without calling the API', async () => {
    let called = false;
    const scope = { projectId: 'p', resolveToken: async () => { called = true; return 't'; } };
    const result = await new TestFirestoreRulesHandler().execute(scope, 'rules', [
      { description: 'ok', expectation: 'ALLOW', method: 'get', path: 'a/b' },
      { description: 'bad', expectation: 'ALLOW', method: 'create', path: 'a/b', data: {}, resource: { x: 1 } },
    ]);
    expect(called).toBe(false);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('INVALID_REQUEST');
    expect(result.error.message).toContain('(case 1, "bad")');
  });

  test('TestFirestoreRulesHandler refuses a malformed case the same way', async () => {
    const scope = { projectId: 'p', resolveToken: async () => { throw new Error('not reached'); } };
    const result = await new TestFirestoreRulesHandler().execute(scope, 'rules', [
      { description: 'typo', expectation: 'ALLOW', method: 'read', path: 'a/b' } as unknown as TestCase,
    ]);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain('method');
  });
});
