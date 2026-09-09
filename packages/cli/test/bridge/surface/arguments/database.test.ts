/**
 * The `database` tool's argument vocabulary: the renames and the key
 * character-set check that `set`, `get`, `remove`, and `update` all share.
 */
import { describe, expect, it } from 'bun:test';

import {
  RENAMES,
  checkPath,
  pathArgument,
} from '../../../../src/bridge/surface/arguments/database.js';
import { failFor } from '../../../../src/bridge/surface/method-validation.js';

const fail = failFor('database', 'set');

describe('the renames', () => {
  it('maps client and SDK-neighbour spellings onto the record shape', () => {
    expect(RENAMES.ref).toBe('path');
    expect(RENAMES.reference).toBe('path');
    expect(RENAMES.key).toBe('path');
    expect(RENAMES.data).toBe('value');
    expect(RENAMES.limit).toBe('limitToFirst');
    expect(RENAMES.orderBy).toBe('orderByChild');
  });
});

describe('checkPath', () => {
  it.each(['.', '#', '$', '[', ']'])('rejects a path holding %s', (character) => {
    const rejection = checkPath('set', { path: `rooms${character}lobby` }, fail);
    expect(rejection).not.toBeNull();
    expect(rejection?.data.field).toBe('path');
    expect(rejection?.summary).toContain(`'${character}'`);
    expect(rejection?.summary).toContain('set rejects the reference');
  });

  it('passes a path with none of the forbidden characters', () => {
    expect(checkPath('set', { path: 'rooms/lobby' }, fail)).toBeNull();
  });
});

describe('pathArgument', () => {
  it('is a required string', () => {
    expect(pathArgument.safeParse('rooms/lobby').success).toBe(true);
    expect(pathArgument.safeParse(undefined).success).toBe(false);
  });
});
