import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('a remote listener keeps its process alive and unsubscribe permits natural exit', async ({ page }) => {
  test.setTimeout(30_000);
  const fixture = await startHostedFixture();
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `
      import { connectRemoteSandbox } from '@pyric/cli/remote';
      const remote = await connectRemoteSandbox({ url: ${JSON.stringify(fixture.info.url)} });
      const unsubscribe = remote.channel.subscribe(
        { target: { __ref: 'doc', path: 'shared/greeting' }, actAs: { mode: 'admin' } },
        snapshot => {
          const hasDocument = snapshot.exists === true;
          if (hasDocument) {
            unsubscribe();
            console.log('Observed');
          } else {
            console.log('Empty');
          }
        },
        error => { console.error(error); process.exitCode = 1; },
      );
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
    child.on('error', error => { stderr += error.message; });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    try {
      await expect.poll(() => stdout).toContain('Empty');
      await page.getByRole('button', { name: 'Write shared document' }).click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await expect.poll(() => stdout).toContain('Observed');
      await expect.poll(() => child.exitCode).toBe(0);
    } finally {
      child.kill('SIGKILL');
      await closed;
      await test.info().attach('consumer-output', { body: `${stdout}\n${stderr}`, contentType: 'text/plain' });
    }
  } finally {
    await test.info().attach('host-stderr', { body: fixture.stderr(), contentType: 'text/plain' });
    await page.close();
    await fixture.stop();
  }
});
