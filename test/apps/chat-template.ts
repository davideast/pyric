/**
 * The create-pyric chat template as a user gets it, for the scenarios that
 * drive it: scaffold it through the packed create-pyric, install it, start its
 * dev server, and send one prompt through its chat UI. Each scenario that
 * uses this adds `create-pyric` to its own package.json.
 */
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { App, DevServer } from './driver.ts';

/** The directory, inside the app directory, the template is scaffolded into. */
export const CHAT_PROJECT = 'my-chat';

/** Scaffolds the chat template with the installed create-pyric and installs it. */
export async function scaffoldChatTemplate(app: App): Promise<void> {
  await app.step('create-pyric scaffolds the chat template', async () => {
    const result = await app.command('node', ['node_modules/create-pyric/dist/bin.js', CHAT_PROJECT, '--template', 'chat']);
    assert.equal(result.code, 0, result.output);
  });
  await app.step('install the scaffolded chat project', () => app.installProject(CHAT_PROJECT));
}

/** Starts the scaffolded project's own Vite dev server, as `npm run dev` does. */
export function startChatDevServer(app: App, env: Record<string, string> = {}): Promise<DevServer> {
  return app.devServer({ cwd: CHAT_PROJECT, env });
}

/**
 * Opens the chat page, signs in through the sandbox's Google sign-in dialog,
 * picks the Direct mode (one AI Logic call, no agent), and sends `prompt`.
 * Returns the page once the reply's text is on it.
 */
export async function sendDirectPrompt(app: App, url: string, prompt: string, reply: string): Promise<Page> {
  const page = await app.page(url);
  await page.getByRole('button', { name: 'Sign in to continue' }).click();
  const dialog = page.locator('dialog[data-pyric-auth][open]');
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  await dialog.locator('input[type="email"]').fill('ada@example.com');
  await dialog.locator('input[placeholder="Display name (optional)"]').fill('Ada');
  await dialog.locator('button.submit').click();
  await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Direct' }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill(prompt);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByText(reply).first().waitFor({ timeout: 60_000 });
  return page;
}

/** One server-sent event of a streamGenerateContent answer whose whole text is `text`. */
export function streamedReply(text: string): string {
  const chunk = { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}
