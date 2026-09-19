import { test, expect } from '@playwright/test';
import { McpHttpClient } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';

test('MCP reads the document written by a hosted browser', async ({ browser }) => {
  const serve = await startHostedFixture();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(serve.info.url);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    const mcp = new McpHttpClient(`${serve.info.url}/__pyric/mcp`);
    await mcp.initialize();
    expect(await mcp.toolsList()).toContain('firestore_get_document');
    await expect(mcp.toolCall('firestore_get_document', { path: 'shared/greeting', as: 'admin' })).resolves.toMatchObject({
      ok: true,
      data: { exists: true, data: { message: 'Hello from the other browser' } },
    });
  } finally {
    await context.close().finally(() => serve.stop());
  }
});

test('MCP seeds hosted state before any browser connects', async ({ browser }) => {
  const serve = await startHostedFixture();
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const mcp = new McpHttpClient(`${serve.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('firestore_create_document', {
      path: 'shared/greeting',
      data: { message: 'Seeded through MCP' },
      as: 'admin',
    })).resolves.toMatchObject({ ok: true });
    for (const context of [first, second]) {
      const page = await context.newPage();
      await page.goto(serve.info.url);
      await expect(page.locator('#document')).toHaveText('Seeded through MCP');
    }
  } finally {
    await Promise.all([first.close(), second.close()]).finally(() => serve.stop());
  }
});
