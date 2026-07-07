#!/usr/bin/env bun
/**
 * Standalone preview-proof helper. Drives Playwright programmatically
 * (NOT through the test runner — this is a debug tool, not part of
 * the e2e suite) to verify the playground's preview chain end-to-end:
 *
 *   workspaceStore.setAppSource(...) →
 *   AppPreview debounce →
 *   compileApp(esbuild-wasm + VFS plugin) →
 *   IframePreview mounts a React root inside the same-origin iframe →
 *   the fixture App renders and is interactive.
 *
 * Use this when the Preview pane misbehaves and you want a fast
 * scripted repro before manual debugging. Useful in CI too — wire
 * to a smoke job that runs after the dev server boots.
 *
 *   bun scripts/preview-proof.ts                # default: localhost:4321
 *   PLAYWRIGHT_BASE_URL=http://localhost:4328 bun scripts/preview-proof.ts
 *   bun scripts/preview-proof.ts --headed       # show the browser
 *
 * Requires the playground dev server to be running already (the
 * script does not spawn it).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(resolve(HERE, 'preview-proof.app.tsx'), 'utf8');
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4321';
const HEADED = process.argv.includes('--headed');

function log(prefix: string, message: string): void {
  console.log(`[preview-proof] ${prefix} ${message}`);
}

function fail(reason: string): never {
  console.error(`[preview-proof] ✘ ${reason}`);
  process.exit(1);
}

async function run(): Promise<void> {
  const browser: Browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  const ignored = [/wasm streaming compile failed/i, /ENOENT/i, /no api key/i];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (ignored.some((p) => p.test(text))) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  try {
    log('→', `goto ${BASE_URL}/`);
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });

    log('→', 'create a session from the home form');
    await page.locator('textarea').first().fill('preview proof');
    await page
      .getByRole('button', { name: 'Start session', exact: true })
      .click();
    await page.waitForURL(/\/playground/, { timeout: 30_000 });

    const previewTab = page.getByRole('button', { name: 'Preview', exact: true });
    await previewTab.waitFor({ state: 'visible', timeout: 30_000 });
    log('✓', 'PlaygroundPage hydrated');

    log('→', 'plant fixture appSource via __pyricTestSeed');
    await page.waitForFunction(
      () => typeof (window as PyricWindow).__pyricTestSeed === 'function',
      { timeout: 10_000 },
    );
    await page.evaluate((source) => {
      (window as PyricWindow).__pyricTestSeed?.({ appSource: source });
    }, FIXTURE);

    log('→', 'bounce Rules → Preview to exercise the flicker repro path');
    await page.getByRole('button', { name: 'Rules', exact: true }).click();
    await page.waitForTimeout(150);
    await previewTab.click();

    const iframe = page.frameLocator('iframe[title="App preview"]');
    const heading = iframe.getByTestId('preview-proof-heading');
    await heading.waitFor({ state: 'visible', timeout: 30_000 });
    const headingText = (await heading.textContent()) ?? '';
    if (!/Preview proof — rendered from \/workspace\/src\/App\.tsx/.test(headingText)) {
      fail(`heading text unexpected: ${JSON.stringify(headingText)}`);
    }
    log('✓', `heading rendered: ${headingText.trim()}`);

    log('→', 'click the counter button twice');
    const counter = iframe.getByTestId('preview-proof-count');
    if ((await counter.textContent()) !== 'clicks: 0') {
      fail(`counter did not start at 0: ${await counter.textContent()}`);
    }
    await iframe.getByTestId('preview-proof-button').click();
    await counter.waitFor({ state: 'visible' });
    if ((await counter.textContent()) !== 'clicks: 1') {
      fail(`counter did not increment to 1: ${await counter.textContent()}`);
    }
    await iframe.getByTestId('preview-proof-button').click();
    if ((await counter.textContent()) !== 'clicks: 2') {
      fail(`counter did not increment to 2: ${await counter.textContent()}`);
    }
    log('✓', 'counter responded to 2 clicks — React root is live');

    if (consoleErrors.length > 0) {
      fail(`console errors leaked:\n${consoleErrors.join('\n')}`);
    }
    log('✓', 'no console errors leaked');
    console.log('[preview-proof] ✓ preview chain works end-to-end');
  } finally {
    await browser.close();
  }
}

interface PyricWindow extends Window {
  __pyricTestSeed?: (partial: { appSource?: string; rules?: string }) => void;
}

run().catch((err) => {
  console.error('[preview-proof] failed:', err);
  process.exit(1);
});
