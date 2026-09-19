import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('repeated oversized remote refusals release operation and listener event-loop holds', async () => {
  const fixture = await startHostedFixture();
  try {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { connectRemoteSandbox } from '@pyric/cli/remote';
      const remote = await connectRemoteSandbox({ url: ${JSON.stringify(fixture.info.url)} });
      for (const cycle of ['first', 'second', 'third']) {
        await assert.rejects(remote.channel.op({
          method: 'setDoc', path: 'shared/oversized', data: { message: 'é'.repeat(6 * 1024 * 1024) },
        }), { code: 'resource-exhausted' });
        await new Promise((resolve, reject) => {
          remote.channel.subscribe({
            target: {
              __ref: 'query', source: { __ref: 'collection', path: 'shared' },
              constraints: [{ kind: 'where', field: 'message', op: '==', value: 'é'.repeat(6 * 1024 * 1024) }],
            },
          }, () => reject(new Error('Unexpected snapshot')), error => {
            assert.equal(error.code, 'resource-exhausted');
            resolve();
          });
        });
        console.log(cycle);
      }
      // No unsubscribe, close, or forced process.exit: terminal refusal owns cleanup.
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
    child.on('error', error => { stderr += error.message; });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await expect.poll(() => stdout).toContain('third');
      await expect.poll(() => child.exitCode).toBe(0);
      expect(stderr).not.toContain('Unhandled');
    } finally {
      child.kill('SIGKILL');
      await closed;
      await test.info().attach('consumer-output', { body: `${stdout}\n${stderr}`, contentType: 'text/plain' });
    }
  } finally {
    await fixture.stop();
  }
});
