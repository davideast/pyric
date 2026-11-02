/**
 * A browser launched after another has closed keeps working once the garbage
 * collector has run. Under Bun 1.3.11 it lost its pipes and hung every later
 * command, which held a whole shard until its job limit.
 */
import { expect, test } from 'bun:test';
import type { Browser } from '@playwright/test';
import { launchScenarioBrowser } from './driver.ts';

const COMMAND_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 30_000;
const COLLECTION_PAUSE_MS = 300;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs the collector twice, with a turn of the event loop for what it finalizes. */
async function collectGarbage(): Promise<void> {
  Bun.gc(true);
  await pause(COLLECTION_PAUSE_MS);
  Bun.gc(true);
  await pause(COLLECTION_PAUSE_MS);
}

async function pageTitle(browser: Browser): Promise<string> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(COMMAND_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(COMMAND_TIMEOUT_MS);
  await page.goto('data:text/html,<title>still answers</title>');
  const title = await page.title();
  await context.close();
  return title;
}

test('a browser launched after another has closed still answers after a collection', async () => {
  const first = await launchScenarioBrowser();
  await pageTitle(first);
  await first.close();

  const second = await launchScenarioBrowser();
  await pageTitle(second);
  await collectGarbage();

  expect(await pageTitle(second)).toBe('still answers');
  await second.close();
}, TEST_TIMEOUT_MS);
