import { connectRemoteSandbox } from '@pyric/cli/remote';
import { expect, test } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('an oversized remote write rejects before sending and leaves both clients usable', async () => {
  const fixture = await startHostedFixture();
  try {
    const requesting = await connectRemoteSandbox({ url: fixture.info.url });
    const healthy = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      await expect(requesting.channel.op({
        method: 'setDoc', path: 'shared/oversized',
        data: { message: 'é'.repeat(6 * 1024 * 1024) }, actAs: { mode: 'admin' },
      })).rejects.toMatchObject({ code: 'resource-exhausted' });
      await expect(healthy.channel.op({
        method: 'getDoc', path: 'shared/oversized', actAs: { mode: 'admin' },
      })).resolves.toMatchObject({ exists: false });
      for (const client of [healthy, requesting]) {
        await client.channel.op({
          method: 'setDoc', path: 'shared/greeting', data: { message: 'Still connected' }, actAs: { mode: 'admin' },
        });
        await expect(client.channel.op({
          method: 'getDoc', path: 'shared/greeting', actAs: { mode: 'admin' },
        })).resolves.toMatchObject({ exists: true, data: { json: '{"message":"Still connected"}' } });
      }
    } finally {
      requesting.close();
      healthy.close();
    }
  } finally {
    await fixture.stop();
  }
});

test('an oversized remote subscription reports one terminal error and releases the listener', async () => {
  const fixture = await startHostedFixture();
  try {
    const remote = await connectRemoteSandbox({ url: fixture.info.url });
    try {
      const errors: string[] = [];
      const snapshots: unknown[] = [];
      const unsubscribe = remote.channel.subscribe({
        target: {
          __ref: 'query', source: { __ref: 'collection', path: 'shared' },
          constraints: [{ kind: 'where', field: 'message', op: '==', value: 'é'.repeat(6 * 1024 * 1024) }],
        },
        actAs: { mode: 'admin' },
      }, snapshot => snapshots.push(snapshot), error => errors.push(error.code));
      try {
        await expect.poll(() => errors).toEqual(['resource-exhausted']);
        await remote.channel.op({
          method: 'setDoc', path: 'shared/greeting', data: { message: 'Healthy listener' }, actAs: { mode: 'admin' },
        });
        const healthy: unknown[] = [];
        const stop = remote.channel.subscribe({
          target: { __ref: 'doc', path: 'shared/greeting' }, actAs: { mode: 'admin' },
        }, snapshot => healthy.push(snapshot));
        try {
          await expect.poll(() => healthy).toMatchObject([{ exists: true }]);
        } finally {
          stop();
        }
        expect(errors).toEqual(['resource-exhausted']);
        expect(snapshots).toEqual([]);
      } finally {
        unsubscribe();
        unsubscribe();
      }
    } finally {
      remote.close();
    }
  } finally {
    await fixture.stop();
  }
});
