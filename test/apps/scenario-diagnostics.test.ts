import { describe, expect, test } from 'bun:test';
import {
  formatStallDiagnosis,
  parseTicks,
  summarize,
  waitForProcessExit,
  type Tick,
} from './node-client-host-restart/scenario.ts';
import {
  formatServerRequestFailure,
  requestDevServer,
  type ServerProcessView,
} from './vite-ssr-client-sdk/scenario.ts';

describe('waitForProcessExit (#1268)', () => {
  test('returns the exit code and clears its deadline timer on fast exit', async () => {
    const prevSetTimeout = globalThis.setTimeout;
    const prevClearTimeout = globalThis.clearTimeout;
    const activeTimers = new Set<ReturnType<typeof setTimeout>>();

    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
      const id = prevSetTimeout(handler, timeout);
      activeTimers.add(id);
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
      if (id !== undefined) activeTimers.delete(id);
      prevClearTimeout(id);
    }) as typeof clearTimeout;

    try {
      const code = await waitForProcessExit(Promise.resolve(0), 90_000);
      expect(code).toBe(0);
      expect(activeTimers.size).toBe(0);
    } finally {
      globalThis.setTimeout = prevSetTimeout;
      globalThis.clearTimeout = prevClearTimeout;
    }
  });

  test('returns timeout when the process does not exit within the bound', async () => {
    const neverExits = new Promise<number | null>(() => {});
    const outcome = await waitForProcessExit(neverExits, 15);
    expect(outcome).toBe('timeout');
  });
});

describe('formatStallDiagnosis (#1268)', () => {
  const sampleTicks: Tick[] = [
    { n: 0, issuedAt: 100, settledAt: 110, ok: true },
    { n: 1, issuedAt: 200, settledAt: 220, ok: true },
    { n: 2, issuedAt: 350, settledAt: 370, ok: true },
  ];

  test('records stored ticks past the restart so lost writer output is distinguishable from stalled writes', async () => {
    const diagnosis = await formatStallDiagnosis({
      writerRunning: true,
      writerPid: 4242,
      writerState: 'S',
      loggedTicks: sampleTicks,
      restartedAt: 250,
      readStoredTicks: async () => [0, 1, 2, 3, 4],
    });
    expect(diagnosis).toBe([
      '[#1268 diagnosis] writer process: running, pid 4242, state S',
      '[#1268 diagnosis] last tick issued before the restart and logged: 1',
      '[#1268 diagnosis] ticks after it the writer logged: [2]',
      '[#1268 diagnosis] ticks after it the host stored: [2,3,4]',
    ].join('\n'));
  });

  test('records the first error line if reading stored ticks fails', async () => {
    const diagnosis = await formatStallDiagnosis({
      writerRunning: false,
      writerPid: 4242,
      writerState: 'unreadable (ENOENT)',
      loggedTicks: sampleTicks.slice(0, 2),
      restartedAt: 250,
      readStoredTicks: async () => {
        throw new Error('ticks.mjs timed out\nstack line');
      },
    });
    expect(diagnosis).toContain('[#1268 diagnosis] writer process: exited, pid 4242, state unreadable (ENOENT)');
    expect(diagnosis).toContain('[#1268 diagnosis] ticks after it the host stored: could not be read: ticks.mjs timed out');
  });

  test('parseTicks and summarize report clean and failed write windows accurately', () => {
    const raw = [
      'tick {"n":0,"issuedAt":1010,"settledAt":1020,"ok":true}',
      'tick {"n":1,"issuedAt":1100,"settledAt":1250,"ok":false,"code":"UNAVAILABLE","message":"dropped"}',
      'tick {"n":2,"issuedAt":1300,"settledAt":1320,"ok":true}',
    ].join('\n');
    const parsed = parseTicks(raw);
    expect(parsed).toHaveLength(3);
    const report = summarize(parsed, [0, 2], 1000, 1200);
    expect(report).toContain('writes: 3, failed: 1, stored: 2');
    expect(report).toContain('failed writes: issued 100 ms to 100 ms, settled 250 ms to 250 ms');
    expect(report).toContain('recovered on its own: true');
  });
});

describe('SSR dev server request diagnostics (#1605)', () => {
  test('reports exit code and log tail when the Vite dev server exited mid-scenario', async () => {
    const exitedProc: ServerProcessView = {
      running: false,
      exited: Promise.resolve(137),
      output: 'VITE v7.1.0 ready in 412 ms\nKilled\n',
    };

    let caught: Error | undefined;
    try {
      await requestDevServer(
        { url: 'http://127.0.0.1:37967', process: exitedProc },
        '/ssr/admin?runner=environment&uid=u1&tag=noext-firebase',
        async () => {
          throw new Error('Unable to connect. Is the computer able to access the url?');
        },
      );
    } catch (error) {
      if (error instanceof Error) caught = error;
      else throw error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toContain(
      'SSR request to http://127.0.0.1:37967/ssr/admin?runner=environment&uid=u1&tag=noext-firebase failed (Unable to connect. Is the computer able to access the url?); dev server process exited with code 137.',
    );
    expect(caught?.message).toContain('Last server output:\nVITE v7.1.0 ready in 412 ms\nKilled');
  });

  test('reports still running and empty-output placeholder when the server has not exited', async () => {
    const runningProc: ServerProcessView = {
      running: true,
      exited: new Promise<number | null>(() => {}),
      output: '',
    };

    const formatted = await formatServerRequestFailure(
      'http://127.0.0.1:37967/ssr/run',
      runningProc,
      new Error('socket hang up'),
    );
    expect(formatted.message).toContain('dev server process still running. Last server output:\n(no server output)');
  });

  test('passes successful and HTTP error responses through unchanged', async () => {
    const runningProc: ServerProcessView = {
      running: true,
      exited: new Promise<number | null>(() => {}),
      output: 'ready',
    };
    const response = await requestDevServer(
      { url: 'http://127.0.0.1:37967', process: runningProc },
      '/ssr/local-admin?runner=legacy',
      async (url) => ({ status: 500, body: `stopped at ${url}` }),
    );
    expect(response).toEqual({
      url: 'http://127.0.0.1:37967/ssr/local-admin?runner=legacy',
      status: 500,
      body: 'stopped at http://127.0.0.1:37967/ssr/local-admin?runner=legacy',
    });
  });
});
