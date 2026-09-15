import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { packedProject, startPackedServer } from './section-four-fixture.js';

test('installed CLI discovery refuses a copied foreign project beacon while its owner can write', async ({ page }) => {
  const owner = packedProject();
  const foreign = packedProject();
  const server = startPackedServer(owner, 'hosted');
  const command = join(owner.consumer, 'node_modules/@pyric/cli/dist/cli/index.js');
  const ownerTransport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp'], cwd: owner.dir, stderr: 'pipe' });
  const foreignTransport = new StdioClientTransport({ command: process.execPath, args: [command, 'mcp'], cwd: foreign.dir, stderr: 'pipe' });
  const good = new Client({ name: 'packed-owner', version: '1' });
  const bad = new Client({ name: 'packed-foreign', version: '1' });
  let refusal = '';
  foreignTransport.stderr?.on('data', (chunk: Buffer) => { refusal += chunk.toString(); });
  try {
    const url = await server.url;
    mkdirSync(join(foreign.dir, '.pyric'));
    copyFileSync(join(owner.dir, '.pyric/serve.json'), join(foreign.dir, '.pyric/serve.json'));
    await expect(bad.connect(foreignTransport)).rejects.toThrow();
    await expect.poll(() => refusal).toContain('another project');
    await page.goto(url);
    await expect(page.locator('#result')).toHaveText('Ready');
    await expect(page.locator('#document')).toHaveText('null');
    await good.connect(ownerTransport);
    const result = await good.callTool({ name: 'firestore_create_document', arguments: {
      path: 'shared/greeting', data: { message: 'Owner discovery works' }, as: 'admin',
    } });
    expect(result.isError).not.toBe(true);
    await expect(page.locator('#document')).toHaveText('{"message":"Owner discovery works"}');
    await page.locator('#write').click();
    await expect(page.locator('#result')).toHaveText('Written');
  } finally {
    await good.close();
    await bad.close();
    await ownerTransport.close();
    await foreignTransport.close();
    await page.close();
    await server.stop();
    owner.close();
    foreign.close();
  }
});

test('installed SDK refuses a bridge URL belonging to another canonical project', async ({ browser, request }) => {
  const expected = packedProject();
  const other = packedProject();
  const expectedServer = startPackedServer(expected, 'hosted');
  const otherServer = startPackedServer(other, 'hosted');
  const appContext = await browser.newContext();
  const otherContext = await browser.newContext();
  try {
    const expectedUrl = await expectedServer.url;
    const otherUrl = await otherServer.url;
    const otherPage = await otherContext.newPage();
    await otherPage.goto(otherUrl);
    await expect(otherPage.locator('#result')).toHaveText('Ready');
    await otherPage.locator('#write').click();
    await expect(otherPage.locator('#result')).toHaveText('Written');
    const original = await otherPage.locator('#document').innerText();
    const initResponse = await request.get(new URL('/__pyric/init.json', otherUrl).href);
    const init: { bridgeUrl: string } = await initResponse.json();
    await appContext.route('**/__pyric/init.json', async route => {
      const response = await route.fetch();
      const originalInit = await response.json();
      await route.fulfill({ response, json: { ...originalInit, bridgeUrl: init.bridgeUrl } });
    });
    const page = await appContext.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(expectedUrl);
    await expect.poll(() => errors).toContain('The selected hosted sandbox belongs to a different project.');
    await expect(page.locator('#write')).toBeDisabled();
    await expect(page.locator('#document')).toHaveText('');
    await expect(otherPage.locator('#document')).toHaveText(original);
    await otherPage.locator('#write').click();
    await expect(otherPage.locator('#result')).toHaveText('Written');
    await expect(otherPage.locator('#document')).not.toHaveText(original);
  } finally {
    await appContext.close();
    await otherContext.close();
    await expectedServer.stop();
    await otherServer.stop();
    expected.close();
    other.close();
  }
});
