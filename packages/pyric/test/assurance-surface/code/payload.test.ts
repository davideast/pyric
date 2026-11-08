import { describe, expect, test } from 'bun:test';
import { kindOf, payloadShape } from '../../../src/assurance-surface/code/payload.js';
import { hole } from '../../../src/assurance-surface/code/paths.js';
import { union, type AVal } from '../../../src/assurance-surface/code/values.js';

const id = (v: AVal): AVal => v;
const obj = (entries: [string, AVal][], optional: string[] = [], open = false): AVal => ({
  k: 'obj',
  props: new Map(entries),
  computed: [],
  open,
  optional: new Set(optional),
});
const uid: AVal = { k: 'str', parts: [hole('uid', [{ source: 'auth.uid', exact: true }])] };

describe('kindOf', () => {
  test('a nullable string is a string; mixed kinds are unknown', () => {
    expect(kindOf(union([{ k: 'str', parts: [] }, { k: 'null' }]))).toBe('string');
    expect(kindOf(union([{ k: 'str', parts: [] }, { k: 'num' }]))).toBe('unknown');
    expect(kindOf({ k: 'fieldValue', name: 'increment' })).toBe('increment');
  });
});

describe('payloadShape', () => {
  test('object fields with kinds, literals and auth provenance', () => {
    const shape = payloadShape(obj([['owner', uid], ['done', { k: 'bool', value: false }], ['n', { k: 'num', value: 3 }]]), id);
    expect(shape).toEqual({
      kind: 'object',
      open: false,
      fields: [
        { name: 'owner', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
        { name: 'done', kind: 'boolean', literal: false },
        { name: 'n', kind: 'number', literal: 3 },
      ],
    });
  });

  test('a field present in only some object alternatives is optional', () => {
    const shape = payloadShape(union([obj([['a', { k: 'num' }]]), obj([['a', { k: 'num' }], ['b', { k: 'num' }]])]), id);
    expect(shape.fields.find((f) => f.name === 'b')?.optional).toBe(true);
    expect(shape.fields.find((f) => f.name === 'a')?.optional).toBeUndefined();
  });

  test('an unknown spread makes the payload open', () => {
    expect(payloadShape(obj([], [], true), id).open).toBe(true);
  });

  test('propagates open from nested unknown spreads and dynamic computed keys', () => {
    const nestedOpen = obj([['profile', obj([['name', { k: 'str', parts: [{ kind: 'lit', text: 'Ada' }] }]], [], true)]]);
    expect(payloadShape(nestedOpen, id, '.').open).toBe(true);

    const nestedDynamicComputed: AVal = {
      k: 'obj',
      props: new Map([
        [
          'flags',
          {
            k: 'obj',
            props: new Map(),
            computed: [{ key: { k: 'str', parts: [hole('flagKey')] }, value: { k: 'bool', value: true } }],
            open: false,
            optional: new Set(),
          },
        ],
      ]),
      computed: [],
      open: false,
      optional: new Set(),
    };
    expect(payloadShape(nestedDynamicComputed, id, '.').open).toBe(true);

    const nestedLiteralComputed: AVal = {
      k: 'obj',
      props: new Map([
        [
          'profile',
          {
            k: 'obj',
            props: new Map(),
            computed: [{ key: { k: 'str', parts: [{ kind: 'lit', text: 'role' }] }, value: { k: 'str', parts: [{ kind: 'lit', text: 'member' }] } }],
            open: false,
            optional: new Set(),
          },
        ],
      ]),
      computed: [],
      open: false,
      optional: new Set(),
    };
    const closedShape = payloadShape(nestedLiteralComputed, id, '.');
    expect(closedShape.open).toBe(false);
    expect(closedShape.fields).toContainEqual({ name: 'profile.role', kind: 'string', literal: 'member' });
  });

  test('a scalar payload keeps its auth provenance', () => {
    expect(payloadShape(uid, id)).toEqual({ kind: 'string', fields: [], open: false, auth: [{ source: 'auth.uid', certainty: 'exact' }] });
  });
});
