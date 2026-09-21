import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import { CLI_PATH } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';

async function cli(projectDir: string, ...args: string[]): Promise<unknown> {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI_PATH, ...args, '--json'], {
    cwd: projectDir,
    timeout: 10_000,
  });
  return JSON.parse(stdout);
}

test('the service CLI takes the Auth message a hosted page issued', async ({ browser }) => {
  const serve = await startHostedFixture();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(serve.info.url);
    await page.evaluate(async () => {
      const app = await import('firebase/app');
      const auth = await import('firebase/auth');
      await auth.sendSignInLinkToEmail(auth.getAuth(app.getApp()), 'reader@example.com', {
        url: location.origin,
        handleCodeInApp: true,
      });
    });

    await expect(cli(serve.dir, 'auth', 'takeAuthMail', '--email', 'reader@example.com')).resolves.toMatchObject({
      ok: true,
      data: { mail: { operation: 'EMAIL_SIGNIN', email: 'reader@example.com', code: expect.any(String) } },
    });
    await expect(cli(serve.dir, 'auth', 'takeAuthMail', '--email', 'reader@example.com')).resolves.toMatchObject({
      ok: true,
      data: { mail: null },
    });
  } finally {
    await context.close().finally(() => serve.stop());
  }
});
