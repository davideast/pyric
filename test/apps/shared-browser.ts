/**
 * The one Chromium every app in a run shares, launched when the first app
 * opens a page.
 *
 * A launch that fails is not kept: the app that asked fails with a message
 * that names the launch, the next app launches again, and closing the run
 * never throws. On CI, a runner whose every step ran 10 to 60 times slower
 * than usual spent Playwright's whole 180 s launch timeout starting Chromium
 * (#2077). A kept rejection went to every later app and was thrown again when
 * the run closed the browser, so the run stopped before its summary and its
 * shard report.
 *
 * Every run reports one line with the launch time, so CI logs show how long
 * Chromium takes on each runner.
 */
import type { Browser } from '@playwright/test';

function secondsSince(started: number): string {
  return ((performance.now() - started) / 1000).toFixed(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stackOf(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

const LAUNCH_FAILED = 'the runner could not launch Chromium, so no page opened';

/**
 * The error an app fails with when the launch fails. The run's report prints
 * its stack, so the stack is set here: Playwright's own, with its call log
 * and the frames that asked for the browser. A stack Bun formats on first
 * read came out as a bare `Error`, without the message, in a real run.
 */
function launchFailure(error: unknown): Error {
  const failure = new Error(`${LAUNCH_FAILED}: ${messageOf(error)}`, { cause: error });
  failure.stack = `${LAUNCH_FAILED}: ${stackOf(error)}`;
  return failure;
}

export class SharedBrowser {
  private launching: Promise<Browser> | undefined;

  constructor(
    private readonly launch: () => Promise<Browser>,
    private readonly report: (line: string) => void,
  ) {}

  /** The run's browser, launched on the first call, or again after a launch failed. */
  get(): Promise<Browser> {
    if (this.launching !== undefined) return this.launching;
    const launching = this.start();
    this.launching = launching;
    // Registered before any caller's handler, so the caller that sees the failure can launch again.
    launching.catch(() => {
      const isStillCurrent = this.launching === launching;
      if (isStillCurrent) this.launching = undefined;
    });
    return launching;
  }

  /** Closes the browser if one launched. A launch that failed, or is still failing, is ignored. */
  async close(): Promise<void> {
    const launching = this.launching;
    this.launching = undefined;
    if (launching === undefined) return;
    const browser = await launching.catch(() => undefined);
    await browser?.close();
  }

  private async start(): Promise<Browser> {
    const started = performance.now();
    try {
      const browser = await this.launch();
      this.report(`[runner] Chromium launched in ${secondsSince(started)} s`);
      return browser;
    } catch (error) {
      const firstLine = messageOf(error).split('\n')[0];
      this.report(`[runner] Chromium did not launch after ${secondsSince(started)} s: ${firstLine}`);
      throw launchFailure(error);
    }
  }
}
