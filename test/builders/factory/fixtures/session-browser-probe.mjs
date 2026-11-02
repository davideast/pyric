/**
 * What a user agent does in its session, with no model: start a server of
 * its own on the session's loopback, then open it in headless Chromium, from
 * a script run with `node`. It prints one `browser` line with what it saw,
 * and what the sandbox lets it do around Chromium. Run by the made-up
 * agent's `browser` mode (`fake-agent-cli.ts`).
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const PORT = 4187;
const PAGE = 'served inside the session';
/** A sign-in button that, like the app's, is disabled while the page reports it is offline. */
const HTML = `<title>${PAGE}</title><h1>${PAGE}</h1><button>Sign in</button><script>document.querySelector('button').disabled = !navigator.onLine;</script>`;
const SERVER = `require('node:http').createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(${JSON.stringify(HTML)}); }).listen(${PORT}, '127.0.0.1');`;
/** The repo's own entry, for a session that names no client: the failure is then the browser's, not the import's. */
const REPO_CLIENT = new URL('../../../../node_modules/@playwright/test/index.mjs', import.meta.url).pathname;

function attempt(action) {
  try {
    action();
    return 'ok';
  } catch (error) {
    return error.code ?? 'error';
  }
}

async function serverAnswers() {
  for (let tries = 0; tries < 100; tries += 1) {
    const answered = await fetch(`http://127.0.0.1:${PORT}/`).then(() => true, () => false);
    if (answered) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function openPage() {
  const { chromium } = await import(process.env.PYRIC_BUILDER_PLAYWRIGHT ?? REPO_CLIENT);
  const browser = await chromium.launch({ headless: true });
  try {
    const bare = await browser.newPage();
    await bare.goto(`http://127.0.0.1:${PORT}/`);
    const bareOnLine = await bare.evaluate(() => navigator.onLine);
    const context = await browser.newContext();
    await context.addInitScript({ path: process.env.PYRIC_BUILDER_ONLINE_SCRIPT });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`);
    const signIn = page.getByRole('button', { name: 'Sign in' });
    return { title: await page.title(), heading: await page.locator('h1').innerText(), bareOnLine, onLine: await page.evaluate(() => navigator.onLine), signInEnabled: await signIn.isEnabled() };
  } finally {
    await browser.close();
  }
}

function surroundings() {
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const hostHome = process.env.PROBE_HOST_HOME;
  return {
    writeTmp: attempt(() => writeFileSync(join(tmpdir(), 'probe'), 'x')),
    writeShm: attempt(() => writeFileSync('/dev/shm/probe', 'x')),
    browsersPath: browsers,
    writeBrowsers: browsers === undefined ? 'unset' : attempt(() => writeFileSync(join(browsers, 'probe'), 'x')),
    besideBrowsers: browsers !== undefined && existsSync(dirname(browsers)) ? readdirSync(dirname(browsers)) : [],
    hostHomeEntries: hostHome !== undefined && existsSync(hostHome) ? readdirSync(hostHome) : [],
    browsersReadable: browsers === undefined ? 'unset' : attempt(() => accessSync(browsers, constants.R_OK)),
  };
}

const server = spawn('node', ['-e', SERVER], { stdio: 'inherit' });
const line = { type: 'browser', ...surroundings() };
try {
  const answered = await serverAnswers();
  if (!answered) throw new Error(`the session's server did not answer on ${PORT}`);
  Object.assign(line, await openPage());
} catch (error) {
  line.error = error instanceof Error ? error.message : String(error);
}
server.kill();
process.stdout.write(`${JSON.stringify(line)}\n`);
