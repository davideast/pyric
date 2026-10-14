/**
 * How a `database` call's `instance` argument becomes a `getDatabase`
 * selector, and the refusal for an instance the project does not have.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import { databaseInstanceCatalog } from '../../../src/bridge/surface/database-instance-catalog.js';
import {
  instanceSelector,
  onInstance,
  unknownInstanceMessage,
} from '../../../src/bridge/surface/database-instance.js';
import type { SurfaceContext } from '../../../src/bridge/surface/types.js';

function contextWith(named: string[]): SurfaceContext {
  const ctx = createSurfaceContext(initializeSandbox(), mkdtempSync(join(tmpdir(), 'pyric-instance-')));
  ctx.databaseInstances = databaseInstanceCatalog({ defaultInstance: 'demo-default-rtdb', named, pending: [] });
  return ctx;
}

describe('instanceSelector', () => {
  it('selects the default instance when no instance is named', async () => {
    expect(await instanceSelector(contextWith([]), undefined)).toBeUndefined();
  });

  it.each(['default', '', 'demo-default-rtdb', 'https://demo-default-rtdb.firebaseio.com/'])(
    'selects the default instance for %p',
    async (raw) => {
      expect(await instanceSelector(contextWith([]), raw)).toBeUndefined();
    },
  );

  it('selects a known instance by its name, whatever form names it', async () => {
    const ctx = contextWith(['shard-00']);
    expect(await instanceSelector(ctx, 'SHARD-00')).toBe('shard-00');
    expect(await instanceSelector(ctx, 'https://shard-00.firebaseio.com')).toBe('shard-00');
  });

  it('throws the refusal for an unknown instance', async () => {
    await expect(instanceSelector(contextWith(['shard-00']), 'shard-09')).rejects.toThrow(
      'database instance "shard-09" is not declared in firebase.json and holds no data in this sandbox. Known instances: demo-default-rtdb (default), shard-00.',
    );
  });
});

describe('unknownInstanceMessage', () => {
  it('names the default by keyword when the project names none, and adds each pending target', () => {
    const message = unknownInstanceMessage('x', {
      named: ['shard-00'],
      pending: ['firebase.json database[1] target "main" selects no instance yet: no Firebase project is set.'],
    });
    expect(message).toBe(
      'database instance "x" is not declared in firebase.json and holds no data in this sandbox. '
        + 'Known instances: default, shard-00. '
        + 'firebase.json database[1] target "main" selects no instance yet: no Firebase project is set.',
    );
  });
});

describe('onInstance', () => {
  it('names a named instance and leaves the default unnamed', () => {
    expect(onInstance('Wrote a', 'shard-00')).toBe('Wrote a on shard-00');
    expect(onInstance('Wrote a', undefined)).toBe('Wrote a');
  });
});
