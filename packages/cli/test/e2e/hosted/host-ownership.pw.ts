import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { CLI_PATH, McpHttpClient } from '../soak/harness.js';
import { startHostedFixture } from './fixture.js';
import { startHost } from './host-process.js';

test('a second hosted process refuses the same project before advertising readiness', async ({ browser }) => {
  const first = await startHostedFixture();
  const second = startHost(first.dir);
  const context = await browser.newContext();
  try {
    await expect(second.startup).resolves.toEqual({ kind: 'exit', code: 2 });
    expect(second.stderr()).toContain('already owns this project');
    const mcp = new McpHttpClient(`${first.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('firestore_create_document', {
      path: 'shared/greeting', data: { message: 'The first host still owns this data' }, as: 'admin',
    })).resolves.toMatchObject({ ok: true });
    const page = await context.newPage();
    await page.goto(first.info.url);
    await expect(page.locator('#document')).toHaveText('The first host still owns this data');
  } finally {
    await context.close();
    await second.stop().finally(() => first.stop());
  }
});

test('a browser persistence process cannot reset a running host\'s acknowledged data', async ({ browser }) => {
  const first = await startHostedFixture();
  try {
    const mcp = new McpHttpClient(`${first.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('firestore_create_document', {
      path: 'shared/greeting', data: { message: 'Saved by the owner' }, as: 'admin',
    })).resolves.toMatchObject({ ok: true });

    const contender = startHost(first.dir, 0, [process.execPath, CLI_PATH], ['--persist', '--fresh']);
    try {
      expect(await contender.startup, contender.stderr()).toEqual({ kind: 'exit', code: 2 });
      expect(contender.stderr()).toContain('already owns this project');
    } finally {
      await contender.stop();
    }

    const terminated = once(first.child, 'exit');
    first.child.kill('SIGKILL');
    await terminated;
    const replacement = startHost(first.dir, first.info.port);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
      const page = await browser.newPage();
      try {
        await page.goto(first.info.url);
        await expect(page.locator('#document')).toHaveText('Saved by the owner');
      } finally {
        await page.close();
      }
    } finally {
      await replacement.stop();
    }
  } finally {
    await first.stop();
  }
});

test('a browser persistence owner excludes a hosted process and releases ownership on shutdown', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-browser-owner-'));
  const owner = startHost(project, 0, [process.execPath, CLI_PATH], ['--persist']);
  try {
    expect(await owner.startup, owner.stderr()).toEqual({ kind: 'ready' });
    const contender = startHost(project);
    try {
      expect(await contender.startup, contender.stderr()).toEqual({ kind: 'exit', code: 2 });
      expect(contender.stderr()).toContain('already owns this project');
    } finally {
      await contender.stop();
    }
    await owner.stop();
    const replacement = startHost(project);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
    } finally {
      await replacement.stop();
    }
  } finally {
    await owner.stop();
    rmSync(project, { recursive: true, force: true });
  }
});

for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
  test(`a host can reacquire its project after ${signal}`, async () => {
    const first = await startHostedFixture();
    try {
      const terminated = once(first.child, 'exit');
      first.child.kill(signal);
      await terminated;
      const replacement = startHost(first.dir, first.info.port);
      try {
        await expect(replacement.startup).resolves.toEqual({ kind: 'ready' });
        const mcp = new McpHttpClient(`${first.info.url}/__pyric/mcp`);
        await mcp.initialize();
        await expect(mcp.toolCall('firestore_create_document', {
          path: 'shared/restarted', data: { ready: true }, as: 'admin',
        })).resolves.toMatchObject({ ok: true });
        await expect(mcp.toolCall('firestore_get_document', { path: 'shared/restarted', as: 'admin' }))
          .resolves.toMatchObject({ ok: true, data: { exists: true, data: { ready: true } } });
      } finally {
        await replacement.stop();
      }
    } finally {
      await first.stop();
    }
  });
}

test('Bun and Node contend for the same hosted project', async () => {
  const first = await startHostedFixture();
  const second = startHost(first.dir, 0, ['bun', CLI_PATH]);
  try {
    const startup = await second.startup;
    expect(startup, second.stderr()).toEqual({ kind: 'exit', code: 2 });
    expect(second.stderr()).toContain('already owns this project');
  } finally {
    await second.stop().finally(() => first.stop());
  }
});

test('a Bun host excludes Node and releases ownership after SIGKILL', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-bun-owner-'));
  const owner = startHost(project, 0, ['bun', CLI_PATH]);
  try {
    expect(await owner.startup, owner.stderr()).toEqual({ kind: 'ready' });
    const contender = startHost(project);
    try {
      expect(await contender.startup, contender.stderr()).toEqual({ kind: 'exit', code: 2 });
      expect(contender.stderr()).toContain('already owns this project');
    } finally {
      await contender.stop();
    }
    const terminated = once(owner.child, 'exit');
    owner.child.kill('SIGKILL');
    await terminated;
    const replacement = startHost(project);
    try {
      expect(await replacement.startup, replacement.stderr()).toEqual({ kind: 'ready' });
    } finally {
      await replacement.stop();
    }
  } finally {
    await owner.stop();
    rmSync(project, { recursive: true, force: true });
  }
});

test('a project symlink cannot start another owner', async () => {
  const first = await startHostedFixture();
  const aliases = mkdtempSync(join(tmpdir(), 'pyric-owner-alias-'));
  const alias = join(aliases, 'project');
  symlinkSync(first.dir, alias, 'junction');
  const second = startHost(alias);
  try {
    expect(await second.startup, second.stderr()).toEqual({ kind: 'exit', code: 2 });
    expect(second.stderr()).toContain('already owns this project');
  } finally {
    await second.stop().finally(() => first.stop());
    rmSync(aliases, { recursive: true, force: true });
  }
});

test('different projects sharing a state directory cannot open competing hosts', async () => {
  const first = await startHostedFixture();
  const project = mkdtempSync(join(tmpdir(), 'pyric-state-alias-'));
  mkdirSync(join(project, '.pyric'));
  symlinkSync(join(first.dir, '.pyric', 'state'), join(project, '.pyric', 'state'), 'junction');
  const second = startHost(project);
  try {
    expect(await second.startup, second.stderr()).toEqual({ kind: 'exit', code: 2 });
    expect(second.stderr()).toContain('already owns this project');
  } finally {
    await second.stop().finally(() => first.stop());
    rmSync(project, { recursive: true, force: true });
  }
});

test('simultaneous hosted starts admit exactly one owner', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-owner-race-'));
  const first = startHost(project);
  const second = startHost(project);
  try {
    const results = await Promise.all([first.startup, second.startup]);
    expect(results, first.stderr() + second.stderr()).toEqual(expect.arrayContaining([{ kind: 'ready' }, { kind: 'exit', code: 2 }]));
    expect(first.stderr() + second.stderr()).toContain('already owns this project');
  } finally {
    await first.stop().finally(() => second.stop());
    rmSync(project, { recursive: true, force: true });
  }
});

test('failed startup does not prevent a corrected project from starting', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-owner-startup-'));
  const config = join(project, 'firebase.json');
  writeFileSync(config, '{');
  const failed = startHost(project);
  try {
    expect(await failed.startup, failed.stderr()).toEqual({ kind: 'exit', code: 2 });
    expect(failed.stderr()).not.toContain('already owns this project');
    expect(readFileSync(config, 'utf8')).toBe('{');
    writeFileSync(config, '{}');
    const corrected = startHost(project);
    try {
      expect(await corrected.startup, corrected.stderr()).toEqual({ kind: 'ready' });
    } finally {
      await corrected.stop();
    }
  } finally {
    await failed.stop();
    rmSync(project, { recursive: true, force: true });
  }
});
