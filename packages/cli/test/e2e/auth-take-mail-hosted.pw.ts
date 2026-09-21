import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../dist/vite.js';

const cliDir = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = join(cliDir, 'dist/cli/index.js');
const app = `
import { initializeApp } from 'firebase/app';
import { getAuth, sendSignInLinkToEmail } from 'firebase/auth';
const auth = getAuth(initializeApp({ projectId: 'served-take-mail' }));
window.issueLink = () => sendSignInLinkToEmail(auth, 'reader@example.com', { url: location.origin, handleCodeInApp: true });
document.querySelector('#status').textContent = 'Ready';
`;

async function cli(projectDir: string, ...args: string[]): Promise<unknown> {
  const { stdout } = await promisify(execFile)(process.execPath, [cliPath, ...args, '--json'], {
    cwd: projectDir,
    timeout: 10_000,
  });
  return JSON.parse(stdout);
}

test('the service CLI takes the Auth message a Node-hosted page issued', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-take-mail-')));
  let server: ViteDevServer | undefined;
  try {
    mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
    symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
    writeFileSync(join(root, 'index.html'), '<output id="status">Starting</output><script type="module" src="/main.js"></script>');
    writeFileSync(join(root, 'main.js'), app);
    server = await createServer({ root, configFile: false, logLevel: 'silent',
      plugins: [pyric({ hosted: true, capture: false, ui: false })],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, cliDir] } },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    const missingUrl = url === undefined;
    if (missingUrl) throw new Error('Vite did not expose a URL');
    await page.goto(url);
    await expect(page.locator('#status')).toHaveText('Ready');
    await page.evaluate(() => Reflect.get(window, 'issueLink')());

    await expect(cli(root, 'auth', 'takeAuthMail', '--email', 'reader@example.com')).resolves.toMatchObject({
      ok: true,
      data: { mail: { operation: 'EMAIL_SIGNIN', email: 'reader@example.com', code: expect.any(String) } },
    });
    await expect(cli(root, 'auth', 'takeAuthMail', '--email', 'reader@example.com')).resolves.toMatchObject({
      ok: true,
      data: { mail: null },
    });
  } finally {
    await page.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
