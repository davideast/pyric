/**
 * The four readings every discriminator route makes of a call's arguments.
 *
 * The variant carries objects, values, and arrays as JSON-encoded strings, so
 * a route that read one loosely would hand a canonical operation a string
 * where it expects a structure. Each reader here refuses the wrong shape
 * rather than passing it on.
 */
import { describe, expect, it } from 'bun:test';

import {
  assign,
  on,
  onBoth,
  parseJsonArray,
  parseJsonObject,
  parseJsonValue,
  text,
} from '../../../../src/bridge/surface/render/discriminator-route-shapes.js';

describe('text', () => {
  it('reads a string argument and nothing else', () => {
    expect(text({ path: 'users/alice' }, 'path')).toBe('users/alice');
    expect(text({ path: 12 }, 'path')).toBeUndefined();
    expect(text({}, 'path')).toBeUndefined();
  });
});

describe('parseJsonObject', () => {
  it('parses an encoded object and refuses anything that is not one', () => {
    expect(parseJsonObject('{"role":"admin"}')).toEqual({ role: 'admin' });
    expect(parseJsonObject(undefined)).toBeUndefined();
    expect(() => parseJsonObject('[1,2]')).toThrow('expected a JSON object');
    expect(() => parseJsonObject('null')).toThrow('expected a JSON object');
  });
});

describe('parseJsonValue', () => {
  it('parses any encoded value', () => {
    expect(parseJsonValue('12')).toBe(12);
    expect(parseJsonValue('"a"')).toBe('a');
    expect(parseJsonValue(undefined)).toBeUndefined();
  });
});

describe('parseJsonArray', () => {
  it('parses an encoded array and refuses anything that is not one', () => {
    expect(parseJsonArray('[1,2]')).toEqual([1, 2]);
    expect(parseJsonArray(undefined)).toBeUndefined();
    expect(() => parseJsonArray('{"a":1}')).toThrow('expected a JSON array');
  });
});

describe('assign', () => {
  it('carries a value and leaves an absent one absent', () => {
    const call: Record<string, unknown> = {};
    assign(call, 'limit', 10);
    assign(call, 'kind', undefined);
    assign(call, 'confirm', false);
    expect(call).toEqual({ limit: 10, confirm: false });
  });
});

describe('on / onBoth', () => {
  it('select on one field, and on two', () => {
    expect(on('action', 'fork')({ action: 'fork' })).toBe(true);
    expect(on('action', 'fork')({ action: 'diff' })).toBe(false);
    const firestoreSet = onBoth('service', 'firestore', 'action', 'set');
    expect(firestoreSet({ service: 'firestore', action: 'set' })).toBe(true);
    expect(firestoreSet({ service: 'database', action: 'set' })).toBe(false);
  });
});
