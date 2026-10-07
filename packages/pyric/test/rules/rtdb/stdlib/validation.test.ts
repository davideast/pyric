import { describe, expect, test } from 'bun:test';
import { pathOwnerOnly, required, rtdbStdlib } from 'pyric/rules';
import { runScenario, type StdlibScenario } from './harness.js';

const { validation } = rtdbStdlib;

const scenario: StdlibScenario = {
  paths: {
    '/players/$uid': {
      read: pathOwnerOnly('$uid'),
      write: pathOwnerOnly('$uid'),
      ...validation.shape(
        {
          name: validation.stringLength(1, 12),
          level: validation.numberBetween(1, 10),
          team: validation.oneOf('red', 'blue'),
          handle: validation.matches('^[a-z0-9_]+$'),
          ready: 'boolean',
        },
        { required: ['name', 'level'] },
      ),
    },
  },
  cases: [],
};

const player = { name: 'Al', level: 3, team: 'red', handle: 'al_1', ready: true };
const stored = { players: { alice: player } };
const write = (description: string, expectation: 'ALLOW' | 'DENY', newData: unknown) =>
  ({ description, expectation, operation: 'write' as const, path: '/players/alice', auth: 'alice', newData });

scenario.cases.push(
  write('a player with every field valid', 'ALLOW', player),
  write('a player with only the required fields', 'ALLOW', { name: 'Al', level: 1 }),
  write('a player missing a required field', 'DENY', { name: 'Al' }),
  write('an empty name', 'DENY', { ...player, name: '' }),
  write('a name over the maximum length', 'DENY', { ...player, name: 'abcdefghijklm' }),
  write('a level over the maximum', 'DENY', { ...player, level: 11 }),
  write('a level written as a string', 'DENY', { ...player, level: '5' }),
  write('a team outside the allowed values', 'DENY', { ...player, team: 'green' }),
  write('a handle that does not match the pattern', 'DENY', { ...player, handle: 'Al!' }),
  write('a ready flag written as a string', 'DENY', { ...player, ready: 'yes' }),
  write('a field outside the shape', 'DENY', { ...player, admin: true }),
  { description: 'an update of one field to a valid value', expectation: 'ALLOW', operation: 'update', path: '/players/alice', auth: 'alice', data: stored, newData: { name: 'Alice' } },
  { description: 'an update of one field to an invalid value', expectation: 'DENY', operation: 'update', path: '/players/alice', auth: 'alice', data: stored, newData: { level: 0 } },
  { description: 'an update that removes a required field', expectation: 'DENY', operation: 'update', path: '/players/alice', auth: 'alice', data: stored, newData: { level: null } },
);

describe('rtdbStdlib.validation', () => {
  test('value checks compile against the node they are placed on', () => {
    expect(validation.stringLength(1, 12)).toBe('newData.isString() && newData.val().length >= 1 && newData.val().length <= 12');
    expect(validation.numberBetween(-1, 1)).toBe('newData.isNumber() && newData.val() >= -1 && newData.val() <= 1');
    expect(validation.oneOf('a', 1, true)).toBe("newData.val() == 'a' || newData.val() == 1 || newData.val() == true");
    expect(validation.matches('^[a-z]+$')).toBe('newData.isString() && newData.val().matches(/^[a-z]+$/)');
    expect(required('a', 'b')).toBe("newData.hasChildren(['a', 'b'])");
  });

  test('shape types each field and closes the node', () => {
    expect(validation.shape({ a: 'string', b: 'number' })).toEqual({
      validate: "newData.hasChildren(['a', 'b'])",
      children: {
        '/a': { validate: 'newData.isString()' },
        '/b': { validate: 'newData.isNumber()' },
        '/$other': { validate: 'false' },
      },
    });
    expect(validation.shape({ a: 'boolean' }, { required: [], open: true })).toEqual({
      children: { '/a': { validate: 'newData.isBoolean()' } },
    });
  });

  test('shape and matches refuse input they cannot compile', () => {
    expect(() => validation.shape({ a: 'string' }, { required: ['b'] })).toThrow();
    expect(() => validation.matches('a/b')).toThrow();
    expect(() => validation.stringLength(3, 1)).toThrow();
  });

  runScenario(scenario);
});
