// The create-pyric chat template on the Node host (#1377). The scenario
// scaffolds the template through the packed create-pyric, installs it, and
// turns on the Node host the way the Vite guide says, `pyric({ hosted: true })`
// in vite.config.ts, because the template has no hosted run mode of its own.
// Its own dev server then serves the sandbox from one Node process.
//
// In Chromium it signs in, sends a message and sees it render, reloads and
// sees it again, and opens a second page on the same conversation that sees
// the next message arrive live. Each of those reads goes through the Node
// host: auth, the Firestore message write, the conversation listener, and
// the durable state the host keeps in the project.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { scenario, sleep, type App } from '../driver.ts';
import { CHAT_PROJECT, scaffoldChatTemplate, sendDirectMessage, signInAsAda, startChatDevServer } from '../chat-template.ts';

const FIRST = 'First message through the Node host';
const SECOND = 'Second message, seen live in another tab';

/** Waits for a browser console line matching `pattern`, and returns it. */
async function waitForConsoleLine(app: App, pattern: RegExp, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const line = app.browserLog.find((entry) => pattern.test(entry));
    if (line !== undefined) return line;
    assert.ok(Date.now() < deadline, `no console line matched ${pattern} within ${timeoutMs / 1000}s`);
    await sleep(250);
  }
}

/** Waits until the page's thread shows a message whose whole text is `text`. */
function seesMessage(page: Page, text: string): Promise<void> {
  return page.getByText(text, { exact: true }).first().waitFor({ timeout: 60_000 });
}

/** Waits for the reply to `prompt` to finish streaming, and checks the composer shows no error. */
async function replyFinishes(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'hidden', timeout: 90_000 });
  const alerts = await page.getByRole('alert').allTextContents();
  assert.deepEqual(alerts, [], 'the composer shows an error after sending');
}

export default scenario(async (app) => {
  await scaffoldChatTemplate(app);

  await app.step('turn on the Node host in the scaffolded vite.config.ts', () => {
    const path = `${CHAT_PROJECT}/vite.config.ts`;
    const config = app.readFile(path);
    // The config's comment also names pyric(), so the edit targets the plugins array.
    const edited = config.replace('tailwindcss(), pyric()]', 'tailwindcss(), pyric({ hosted: true })]');
    assert.notEqual(edited, config, 'the scaffolded vite.config.ts has no pyric() plugin to edit');
    app.writeFile(path, edited);
  });

  const host = await app.step('start the scaffolded dev server', () => startChatDevServer(app));

  const page = await app.step('the page runs its firebase/* on the Node host', async () => {
    const opened = await app.page(host.url);
    const line = await waitForConsoleLine(app, /\[pyric sandbox\] firebase\/\*/, 30_000);
    assert.match(line, /on the dev server/, line);
    return opened;
  });

  await app.step('sign in through the sandbox Google dialog', () => signInAsAda(page));

  const conversationUrl = await app.step('a sent message renders in the thread', async () => {
    await sendDirectMessage(page, FIRST);
    await seesMessage(page, FIRST);
    await page.waitForURL(/[?&]conversation=/, { timeout: 30_000 });
    await replyFinishes(page);
    return page.url();
  });

  await app.step('the Node host keeps the project state on disk', () => {
    const state = join(app.dir, CHAT_PROJECT, '.pyric', 'state', 'hosted');
    assert.ok(existsSync(state), `no hosted state directory at ${state}`);
  });

  await app.step('after a reload the message renders again', async () => {
    await page.reload();
    await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 60_000 });
    await seesMessage(page, FIRST);
  });

  const second = await app.step('a second page on the conversation shows the message', async () => {
    const opened = await app.page(conversationUrl);
    await opened.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 60_000 });
    await seesMessage(opened, FIRST);
    return opened;
  });

  await app.step('a message sent from the first page appears live on the second', async () => {
    await sendDirectMessage(page, SECOND);
    await seesMessage(page, SECOND);
    await seesMessage(second, SECOND);
    await replyFinishes(page);
  });
});
