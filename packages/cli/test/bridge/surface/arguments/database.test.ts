/**
 * The `database` tool's argument vocabulary: the renames and the key
 * character-set check that `set`, `get`, `remove`, and `update` all share.
 */
import { describe, expect, it } from 'bun:test';

import {
  RENAMES,
  checkInstance,
  checkPath,
  checkReference,
  instanceArgument,
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

  it('maps the SDK and Admin SDK URL spellings onto instance', () => {
    expect(RENAMES.url).toBe('instance');
    expect(RENAMES.databaseURL).toBe('instance');
    expect(RENAMES.databaseUrl).toBe('instance');
  });
});

describe('checkInstance', () => {
  it.each([undefined, 'default', 'shard-00', 'https://shard-00.firebaseio.com', 'http://localhost:9000/?ns=shard-00'])(
    'passes %s',
    (instance) => {
      expect(checkInstance({ path: 'rooms', instance }, fail)).toBeNull();
    },
  );

  it('rejects a URL with a child path, with the SDK message', () => {
    const rejection = checkInstance({ instance: 'https://shard-00.firebaseio.com/rooms' }, fail);
    expect(rejection?.data.field).toBe('instance');
    expect(rejection?.summary).toContain('Database URL must point to the root of a Firebase Database');
  });

  it('rejects a name the instance grammar forbids', () => {
    const rejection = checkInstance({ instance: 'shard_00' }, fail);
    expect(rejection?.data.field).toBe('instance');
    expect(rejection?.summary).toContain('Cannot parse Firebase url');
  });
});

describe('checkReference', () => {
  it('reports the path before the instance', () => {
    const rejection = checkReference('set', { path: 'a.b', instance: 'shard_00' }, fail);
    expect(rejection?.data.field).toBe('path');
  });

  it('reports the instance when the path is valid', () => {
    const rejection = checkReference('set', { path: 'a/b', instance: 'shard_00' }, fail);
    expect(rejection?.data.field).toBe('instance');
  });
});

describe('instanceArgument', () => {
  it('is an optional string', () => {
    expect(instanceArgument.safeParse(undefined).success).toBe(true);
    expect(instanceArgument.safeParse('shard-00').success).toBe(true);
    expect(instanceArgument.safeParse(1).success).toBe(false);
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
