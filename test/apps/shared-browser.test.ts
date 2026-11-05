import { describe, expect, test } from 'bun:test';
import type { Browser } from '@playwright/test';
import { SharedBrowser } from './shared-browser.ts';

/** A stand-in for Playwright's Browser that counts its closes. */
function fakeBrowser(): Browser & { closes: number } {
  const browser = { closes: 0, close: async () => { browser.closes += 1; } };
  return browser as unknown as Browser & { closes: number };
}

/** A launcher that answers each call with the next outcome, and counts its calls. */
function launcher(outcomes: Array<Browser | Error>): { launch: () => Promise<Browser>; calls: () => number } {
  let calls = 0;
  const launch = async () => {
    const outcome = outcomes[calls];
    calls += 1;
    if (outcome === undefined) throw new Error(`launch called ${calls} times, more than the test expected`);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { launch, calls: () => calls };
}

describe('SharedBrowser (#2077)', () => {
  test('every app shares one launch, and the run reports how long it took', async () => {
    const browser = fakeBrowser();
    const { launch, calls } = launcher([browser]);
    const lines: string[] = [];
    const shared = new SharedBrowser(launch, (line) => lines.push(line));

    const [first, second] = await Promise.all([shared.get(), shared.get()]);
    expect(first).toBe(browser);
    expect(second).toBe(browser);
    expect(await shared.get()).toBe(browser);
    expect(calls()).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[runner\] Chromium launched in \d+\.\d s$/);
  });

  test('a failed launch names the runner, not the step, and keeps Playwright\'s message and stack', async () => {
    const timeout = new Error('launch: Timeout 180000ms exceeded.');
    timeout.stack = 'TimeoutError: launch: Timeout 180000ms exceeded.\nCall log:\n  - <launched> pid=3520\n    at launch (run.ts:355:37)';
    const { launch } = launcher([timeout]);
    const lines: string[] = [];
    const shared = new SharedBrowser(launch, (line) => lines.push(line));

    const error = await shared.get().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('the runner could not launch Chromium, so no page opened: launch: Timeout 180000ms exceeded.');
    // The run's report prints the stack.
    expect((error as Error).stack).toBe(`the runner could not launch Chromium, so no page opened: ${timeout.stack}`);
    expect((error as Error).cause).toBe(timeout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[runner\] Chromium did not launch after \d+\.\d s: launch: Timeout 180000ms exceeded\.$/);
  });

  test('a failed launch is not kept: the next app launches again', async () => {
    const browser = fakeBrowser();
    const { launch, calls } = launcher([new Error('launch: Timeout 180000ms exceeded.'), browser]);
    const shared = new SharedBrowser(launch, () => {});

    await expect(shared.get()).rejects.toThrow('could not launch Chromium');
    expect(await shared.get()).toBe(browser);
    expect(calls()).toBe(2);
  });

  test('close after a failed launch resolves, so the run still writes its summary and shard report', async () => {
    const { launch } = launcher([new Error('launch: Timeout 180000ms exceeded.')]);
    const shared = new SharedBrowser(launch, () => {});
    await shared.get().catch(() => {});

    await shared.close();
  });

  test('close while a launch is still failing resolves too', async () => {
    const { launch } = launcher([new Error('launch: Timeout 180000ms exceeded.')]);
    const shared = new SharedBrowser(launch, () => {});
    const launching = shared.get().catch(() => {});

    await shared.close();
    await launching;
  });

  test('close closes a launched browser once, and does nothing when no app opened a page', async () => {
    const browser = fakeBrowser();
    const shared = new SharedBrowser(launcher([browser]).launch, () => {});
    await shared.get();

    await shared.close();
    await shared.close();
    expect(browser.closes).toBe(1);

    const { launch, calls } = launcher([]);
    await new SharedBrowser(launch, () => {}).close();
    expect(calls()).toBe(0);
  });
});
