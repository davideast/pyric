import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox, type RemoteSandboxChannel } from 'pyric/sandbox';
import { createRemoteSandboxHandle } from '../../../cli/src/remote/index.js';
import { ADMIN_APP_TARGET, deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getAuth } from '../../src/auth/index.js';

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('getAuth service routing', () => {
  it('resolves the default app when called without arguments', async () => {
    const sandbox = initializeSandbox();
    initializeApp({ sandbox });
    const auth = getAuth();
    const created = await auth.createUser({ uid: 'user-default', email: 'user@example.com' });
    expect(created.uid).toBe('user-default');
  });

  it('throws app/no-app when no default app exists', () => {
    expect(() => getAuth()).toThrow(/The default Firebase app does not exist/);
  });

  it('rejects deleted apps and unbranded objects', async () => {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox }, 'disposable');
    await deleteApp(app);
    expect(() => getAuth(app)).toThrow(/already been deleted/);
    expect(() => getAuth({} as never)).toThrow(TypeError);
    const nonSandboxApp = { [ADMIN_APP_TARGET]: 'prod', sandbox: {} } as never;
    expect(() => getAuth(nonSandboxApp)).toThrow(/expected a sandbox admin app/);
  });

  it('routes remote-branded sandboxes to the remote channel arm', async () => {
    const calls: string[] = [];
    const channel: RemoteSandboxChannel = {
      op: async (payload) => {
        calls.push(String(payload.method));
        return [];
      },
      subscribe: () => () => {},
    };
    const remote = createRemoteSandboxHandle({
      channel,
      serveUrl: 'http://localhost:0',
      close: () => {},
    });
    const app = initializeApp({ sandbox: remote }, 'remote-app');
    const auth = getAuth(app);
    const page = await auth.listUsers();
    expect(page.users).toEqual([]);
    expect(calls).toEqual(['auth.listUsers']);
  });
});
