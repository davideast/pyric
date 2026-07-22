import { expect, it } from 'bun:test';
import { Database } from '../../src/database/database-handle.js';
import { TARGET_SYMBOL, type Target } from '../../src/database/routing.js';

it('owns its routing target and Firebase-compatible inert internals', async () => {
  const target = { kind: 'sandbox' } as Target;
  const app = { name: 'test' } as never;
  const database = new Database(target, app);
  expect(database[TARGET_SYMBOL]).toBe(target);
  expect(database.app).toBe(app);
  expect(database.type).toBe('database');
  expect(database._repo).toBeUndefined();
  await expect(database._delete()).resolves.toBeUndefined();
});
