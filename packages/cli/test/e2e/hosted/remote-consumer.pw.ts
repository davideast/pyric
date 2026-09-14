import { test, expect } from '@playwright/test';
import { connectRemoteSandbox } from '@pyric/cli/remote';
import { startHostedFixture } from './fixture.js';

test('an authenticated remote consumer reads a document written by the hosted browser', async ({ browser }) => {
  const serve = await startHostedFixture();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(serve.info.url);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    const remote = await connectRemoteSandbox({ url: serve.info.url });
    try {
      await remote.channel.op({ method: 'auth.signInAnonymously' });
      await expect(remote.channel.op({ method: 'getDoc', path: 'shared/greeting' })).resolves.toMatchObject({
        exists: true,
        data: { json: '{"message":"Hello from the other browser"}' },
      });
    } finally {
      remote.close();
    }
  } finally {
    await context.close().finally(() => serve.stop());
  }
});

test('a remote listener observes a hosted browser write', async ({ browser }) => {
  const serve = await startHostedFixture();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const remote = await connectRemoteSandbox({ url: serve.info.url });
    try {
      await remote.channel.op({ method: 'auth.signInAnonymously' });
      const observations: unknown[] = [];
      const unsubscribe = remote.channel.subscribe(
        { target: { __ref: 'doc', path: 'shared/greeting' } },
        snapshot => observations.push(snapshot),
        error => observations.push({ error: error.code }),
      );
      try {
        await expect.poll(() => observations).toMatchObject([{ exists: false }]);
        await page.getByRole('button', { name: 'Write shared document' }).click();
        await expect(page.locator('#write-result')).toHaveText('Written');
        await expect.poll(() => observations).toMatchObject([
          { exists: false },
          { exists: true, data: { json: '{"message":"Hello from the other browser"}' } },
        ]);
      } finally {
        unsubscribe();
      }
    } finally {
      remote.close();
    }
  } finally {
    await context.close().finally(() => serve.stop());
  }
});

test('the hosted relay explicitly refuses unbounded event subscriptions', async () => {
  const serve = await startHostedFixture();
  try {
    const remote = await connectRemoteSandbox({ url: serve.info.url });
    try {
      const outcomes: unknown[] = [];
      const unsubscribe = remote.channel.subscribe(
        { target: 'events' },
        value => outcomes.push(value),
        error => outcomes.push(error.code),
      );
      try {
        await expect.poll(() => outcomes).toEqual(['unimplemented']);
      } finally {
        unsubscribe();
      }
    } finally {
      remote.close();
    }
  } finally {
    await serve.stop();
  }
});

test('remote consumers keep independent hosted auth sessions without a browser', async () => {
  const serve = await startHostedFixture();
  try {
    const first = await connectRemoteSandbox({ url: serve.info.url });
    try {
      const second = await connectRemoteSandbox({ url: serve.info.url });
      try {
        await first.channel.op({ method: 'auth.signInAnonymously' });
        await first.channel.op({ method: 'setDoc', path: 'shared/greeting', data: { message: 'From remote' } });
        await expect(second.channel.op({ method: 'getDoc', path: 'shared/greeting' })).rejects.toMatchObject({ code: 'permission-denied' });
        await second.channel.op({ method: 'auth.signInAnonymously' });
        await first.channel.op({ method: 'auth.signOut' });
        await expect(second.channel.op({ method: 'getDoc', path: 'shared/greeting' })).resolves.toMatchObject({
          exists: true,
          data: { json: '{"message":"From remote"}' },
        });
        await expect(first.channel.op({ method: 'getDoc', path: 'shared/greeting' })).rejects.toMatchObject({ code: 'permission-denied' });
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  } finally {
    await serve.stop();
  }
});
