import { describe, expect, it } from 'bun:test';

import { createFirebaseRtdbDataTransport } from '../../src/registry/rtdb-data-transport.js';

describe('Firebase RTDB data transport', () => {
  it('reads admin data through the Admin SDK shape', async () => {
    const transport = createFirebaseRtdbDataTransport({
      databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
      getAdminDatabase: () => ({
        ref: () => ({
          get: async () => ({ val: () => ({ name: 'Alice', role: 'admin' }) }),
          set: async () => {},
          update: async () => {},
          push: async () => ({ key: '-NadminKey' }),
          remove: async () => {},
        }),
      }),
      getClientDatabase: async () => ({}),
      client: {
        ref: () => ({}),
        get: async () => ({ val: () => null }),
        set: async () => {},
        update: async () => {},
        push: async () => ({ key: '-NclientKey' }),
        remove: async () => {},
      },
    });

    await expect(transport.get('/users/alice')).resolves.toEqual({
      name: 'Alice',
      role: 'admin',
    });
  });

  it('reads user data through the rules-enforcing Client SDK shape', async () => {
    const clientDatabase = { actor: 'alice' };
    const transport = createFirebaseRtdbDataTransport({
      databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
      getAdminDatabase: () => ({
        ref: () => ({
          get: async () => ({ val: () => null }),
          set: async () => {},
          update: async () => {},
          push: async () => ({ key: '-NadminKey' }),
          remove: async () => {},
        }),
      }),
      getClientDatabase: async () => clientDatabase,
      client: {
        ref: (database, path) => ({ database, path }),
        get: async () => ({ val: () => ({ visibility: 'rules-enforced' }) }),
        set: async () => {},
        update: async () => {},
        push: async () => ({ key: '-NclientKey' }),
        remove: async () => {},
      },
    });

    await expect(
      transport.get('/private', { uid: 'alice' }),
    ).resolves.toEqual({ visibility: 'rules-enforced' });
  });

  it('writes admin data through the Admin SDK shape', async () => {
    const values = new Map<string, unknown>();
    const transport = createFirebaseRtdbDataTransport({
      databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
      getAdminDatabase: () => ({
        ref: (path) => ({
          get: async () => ({ val: () => values.get(path) ?? null }),
          set: async (value) => { values.set(path, value); },
          update: async () => {},
          push: async () => ({ key: '-NadminKey' }),
          remove: async () => {},
        }),
      }),
      getClientDatabase: async () => ({}),
      client: {
        ref: () => ({}),
        get: async () => ({ val: () => null }),
        set: async () => {},
        update: async () => {},
        push: async () => ({ key: '-NclientKey' }),
        remove: async () => {},
      },
    });

    await transport.set('/users/bob', { name: 'Bob' });
    await expect(transport.get('/users/bob')).resolves.toEqual({ name: 'Bob' });
  });

  it('writes user data through the rules-enforcing Client SDK shape', async () => {
    const values = new Map<string, unknown>();
    const transport = createFirebaseRtdbDataTransport({
      databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
      getAdminDatabase: () => ({
        ref: () => ({
          get: async () => ({ val: () => null }),
          set: async () => {},
          update: async () => {},
          push: async () => ({ key: '-NadminKey' }),
          remove: async () => {},
        }),
      }),
      getClientDatabase: async () => ({}),
      client: {
        ref: (_database, path) => path,
        get: async (path) => ({ val: () => values.get(path as string) ?? null }),
        set: async (path, value) => { values.set(path as string, value); },
        update: async () => {},
        push: async () => ({ key: '-NclientKey' }),
        remove: async () => {},
      },
    });
    const auth = { uid: 'alice' };

    await transport.set('/users/alice', { name: 'Alice' }, auth);
    await expect(transport.get('/users/alice', auth)).resolves.toEqual({ name: 'Alice' });
  });

  it('updates data through both Firebase SDK shapes', async () => {
    const adminValues = new Map<string, Record<string, unknown>>([
      ['/users/admin', { name: 'Admin' }],
    ]);
    const userValues = new Map<string, Record<string, unknown>>([
      ['/users/alice', { name: 'Alice' }],
    ]);
    const transport = createFirebaseRtdbDataTransport({
      databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
      getAdminDatabase: () => ({
        ref: (path) => ({
          get: async () => ({ val: () => adminValues.get(path) ?? null }),
          set: async () => {},
          update: async (value) => {
            adminValues.set(path, { ...(adminValues.get(path) ?? {}), ...value });
          },
          push: async () => ({ key: '-NadminKey' }),
          remove: async () => {},
        }),
      }),
      getClientDatabase: async () => ({}),
      client: {
        ref: (_database, path) => path,
        get: async (path) => ({ val: () => userValues.get(path as string) ?? null }),
        set: async () => {},
        update: async (path, value) => {
          const key = path as string;
          userValues.set(key, { ...(userValues.get(key) ?? {}), ...value });
        },
        push: async () => ({ key: '-NclientKey' }),
        remove: async () => {},
      },
    });
    const auth = { uid: 'alice' };

    await transport.update('/users/admin', { role: 'owner' });
    await transport.update('/users/alice', { role: 'member' }, auth);
    await expect(transport.get('/users/admin')).resolves.toEqual({
      name: 'Admin',
      role: 'owner',
    });
    await expect(transport.get('/users/alice', auth)).resolves.toEqual({
      name: 'Alice',
      role: 'member',
    });
  });

  it('returns push keys from both Firebase SDK shapes', async () => {
    const transport = createFirebaseRtdbDataTransport({
      databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
      getAdminDatabase: () => ({
        ref: () => ({
          get: async () => ({ val: () => null }),
          set: async () => {},
          update: async () => {},
          push: async () => ({ key: '-NadminKey' }),
          remove: async () => {},
        }),
      }),
      getClientDatabase: async () => ({}),
      client: {
        ref: () => ({}),
        get: async () => ({ val: () => null }),
        set: async () => {},
        update: async () => {},
        push: async () => ({ key: '-NclientKey' }),
        remove: async () => {},
      },
    });

    await expect(transport.push('/posts', { title: 'Admin' })).resolves.toEqual({
      key: '-NadminKey',
    });
    await expect(
      transport.push('/posts', { title: 'User' }, { uid: 'alice' }),
    ).resolves.toEqual({ key: '-NclientKey' });
  });

  it('removes data through both Firebase SDK shapes', async () => {
    const adminValues = new Map<string, unknown>([['/admin', { live: true }]]);
    const userValues = new Map<string, unknown>([['/user', { live: true }]]);
    const transport = createFirebaseRtdbDataTransport({
      databaseUrl: 'https://demo-default-rtdb.firebaseio.com',
      getAdminDatabase: () => ({
        ref: (path) => ({
          get: async () => ({ val: () => adminValues.get(path) ?? null }),
          set: async () => {},
          update: async () => {},
          push: async () => ({ key: '-NadminKey' }),
          remove: async () => { adminValues.delete(path); },
        }),
      }),
      getClientDatabase: async () => ({}),
      client: {
        ref: (_database, path) => path,
        get: async (path) => ({ val: () => userValues.get(path as string) ?? null }),
        set: async () => {},
        update: async () => {},
        push: async () => ({ key: '-NclientKey' }),
        remove: async (path) => { userValues.delete(path as string); },
      },
    });
    const auth = { uid: 'alice' };

    await transport.remove('/admin');
    await transport.remove('/user', auth);
    await expect(transport.get('/admin')).resolves.toBeNull();
    await expect(transport.get('/user', auth)).resolves.toBeNull();
  });
});
