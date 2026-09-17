import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { startHostedFixture } from './fixture.js';

test('a SQLite failure reaches diagnostics and idle browser chips, and blocks later writes', async ({ browser }) => {
  test.setTimeout(30_000);
  const fixture = await startHostedFixture();
  const context = await browser.newContext();
  try {
    const writer = await context.newPage();
    const observer = await context.newPage();
    await writer.goto(fixture.info.url);
    await observer.goto(fixture.info.url);
    await expect(writer.locator('#write')).toBeEnabled();
    await expect(observer.locator('#write')).toBeEnabled();
    const fault = new DatabaseSync(join(fixture.dir, '.pyric/state/hosted/state.sqlite'));
    try { fault.exec("CREATE TRIGGER fail_records BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT, 'injected failure'); END"); }
    finally { fault.close(); }
    await writer.locator('#write').click();
    await expect(writer.locator('#write-result')).toContainText('could not be persisted');
    const response = await writer.request.get(`${fixture.info.url}/__pyric/diagnostics`);
    expect((await response.json()).server.persistence).toMatchObject({ state: 'unhealthy' });
    await observer.getByRole('button', { name: 'Open pyric', exact: true }).click();
    await observer.getByRole('tab', { name: 'Sandbox', exact: true }).click();
    await expect(observer.getByText('Persistence failed — mutations blocked. Repair the store and restart.', { exact: true })).toBeVisible();
    await observer.locator('#write').click();
    await expect(observer.locator('#write-result')).toContainText('not executed');
  } finally {
    await context.close().finally(() => fixture.stop());
  }
});
