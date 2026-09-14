import { once } from 'node:events';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../../dist/vite.js';
import { McpHttpClient } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

function createPersistedVite(projectDir: string, options: { fresh?: boolean; seed?: string } = {}) {
  const root = realpathSync(projectDir);
  return createServer({
    root,
    configFile: false,
    plugins: [pyric({ persist: true, capture: false, ui: false, ...options })],
    server: { host: '127.0.0.1', port: 0 },
    cacheDir: join(root, '.vite'),
    logLevel: 'silent',
  });
}

test('Vite persistence cannot reset a running host\'s acknowledged data', async ({ browser }) => {
  const owner = await startHostedFixture();
  let vite: ViteDevServer | undefined;
  try {
    const mcp = new McpHttpClient(`${owner.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('firestore_create_document', {
      path: 'shared/greeting', data: { message: 'Saved before Vite starts' }, as: 'admin',
    })).resolves.toMatchObject({ ok: true });

    const startVite = async (): Promise<void> => {
      vite = await createPersistedVite(owner.dir, { fresh: true });
      await vite.listen();
    };
    await expect(startVite()).rejects.toThrow('already owns this project');
    await vite?.close();

    const terminated = once(owner.child, 'exit');
    owner.child.kill('SIGKILL');
    await terminated;
    const replacement = startHost(owner.dir, owner.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const page = await browser.newPage();
      try {
        await page.goto(owner.info.url);
        await expect(page.locator('#document')).toHaveText('Saved before Vite starts');
      } finally {
        await page.close();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    await vite?.close();
    await owner.stop();
  }
});

test('Vite keeps state ownership across restart and releases it on close', async ({ browser }) => {
  const fixture = await startHostedFixture();
  let vite: ViteDevServer | undefined;
  try {
    const mcp = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('firestore_create_document', {
      path: 'shared/greeting', data: { message: 'Handed to Vite' }, as: 'admin',
    })).resolves.toMatchObject({ ok: true });
    const terminated = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await terminated;
    vite = await createPersistedVite(fixture.dir);
    await vite.listen();
    await vite.restart();
    const url = vite.resolvedUrls?.local[0];
    const hasNoUrl = url === undefined;
    if (hasNoUrl) throw new Error('The Vite fixture did not expose its listening URL.');
    const contender = startHost(fixture.dir);
    try {
      expect(await contender.startup, contender.stderr()).toEqual({ kind: 'exit', code: 2 });
      expect(contender.stderr()).toContain('already owns this project');
    } finally {
      await contender.stop();
    }
    const page = await browser.newPage();
    try {
      await page.goto(url);
      await expect(page.locator('#document')).toHaveText('Handed to Vite');
    } finally {
      await page.close();
    }
    await vite.close();
    const replacement = startHost(fixture.dir);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
    } finally {
      await replacement.stop();
    }
  } finally {
    await vite?.close();
    await fixture.stop();
  }
});

test('failed Vite startup releases state ownership', async () => {
  const fixture = await startHostedFixture();
  let vite: ViteDevServer | undefined;
  try {
    const terminated = once(fixture.child, 'exit');
    fixture.child.kill('SIGTERM');
    await terminated;
    writeFileSync(join(fixture.dir, 'broken-seed.json'), '{');
    const startVite = async (): Promise<void> => {
      vite = await createPersistedVite(fixture.dir, { seed: 'broken-seed.json' });
    };
    await expect(startVite()).rejects.toThrow('failed to read seed');
    const replacement = startHost(fixture.dir);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
    } finally {
      await replacement.stop();
    }
  } finally {
    await vite?.close();
    await fixture.stop();
  }
});
