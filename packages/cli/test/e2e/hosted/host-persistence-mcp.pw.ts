import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { McpHttpClient } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';

test('an unhealthy host serves an MCP read from its in-memory state', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const mcp = new McpHttpClient(`${serve.info.url}/__pyric/mcp`);
    await mcp.initialize();
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toContainText('committed in memory');
    await expect(mcp.toolCall('firestore_get_document', { path: 'shared/greeting', as: 'admin' }))
      .resolves.toMatchObject({
        ok: true,
        data: { exists: true, data: { message: 'Hello from the other browser' } },
      });
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('an unhealthy host refuses an MCP mutation before changing the document', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const mcp = new McpHttpClient(`${serve.info.url}/__pyric/mcp`);
    await mcp.initialize();
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toContainText('committed in memory');
    await expect(mcp.toolCall('firestore_update_document', {
      path: 'shared/greeting', data: { message: 'Must not execute' }, as: 'admin',
    })).resolves.toMatchObject({
      ok: false,
      summary: expect.stringContaining('The mutation was not executed because hosted persistence is unhealthy.'),
    });
    await expect(page.locator('#document')).toHaveText('Hello from the other browser');
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('an MCP user-creation refusal survives a persistence failure', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const mcp = new McpHttpClient(`${serve.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('auth_create_user', {
      uid: 'existing-reader', email: 'reader@example.test',
    })).resolves.toMatchObject({ ok: true });
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await expect(mcp.toolCall('auth_create_user', {
      uid: 'existing-reader', email: 'replacement@example.test',
    })).resolves.toMatchObject({
      ok: false,
      summary: expect.stringContaining('auth/uid-already-exists'),
    });
    await expect(mcp.toolCall('auth_get_user', { uid: 'existing-reader' })).resolves.toMatchObject({
      ok: true, data: { user: { uid: 'existing-reader', email: 'reader@example.test' } },
    });
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('an MCP read identifies unhealthy in-memory state in its result', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const mcp = new McpHttpClient(`${serve.info.url}/__pyric/mcp`);
    await mcp.initialize();
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await page.getByRole('button', { name: 'Write shared document' }).click();
    await expect(page.locator('#write-result')).toContainText('committed in memory');
    await expect(mcp.toolCall('firestore_get_document', { path: 'shared/greeting', as: 'admin' }))
      .resolves.toMatchObject({
        ok: true,
        summary: expect.stringContaining('Hosted persistence is unhealthy; this read reflects in-memory state.'),
        data: { exists: true, data: { message: 'Hello from the other browser' } },
      });
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});

test('an MCP partial import keeps its receipt and warns about failed persistence', async ({ page }) => {
  const serve = await startHostedFixture();
  const stateDirectory = join(serve.dir, '.pyric', 'state');
  try {
    await page.goto(serve.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    const mcp = new McpHttpClient(`${serve.info.url}/__pyric/mcp`);
    await mcp.initialize();
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);
    await expect(mcp.toolCall('auth_import_users', {
      users: [
        { uid: 'partial-reader', email: 'reader@example.test' },
        { uid: 'partial-reader', email: 'replacement@example.test' },
      ],
    })).resolves.toMatchObject({
      ok: false,
      summary: 'Imported 1 of 2 users; 1 failed\nPersistence also failed; some changes may exist only in memory. Inspect host state before retrying.',
      data: {
        created: ['partial-reader'],
        errors: [{ index: 1, uid: 'partial-reader', code: 'auth/uid-already-exists' }],
      },
    });
    await expect(mcp.toolCall('auth_get_user', { uid: 'partial-reader' })).resolves.toMatchObject({
      ok: true, data: { user: { uid: 'partial-reader', email: 'reader@example.test' } },
    });
  } finally {
    chmodSync(stateDirectory, 0o700);
    await serve.stop();
  }
});
