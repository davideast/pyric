/**
 * A host route's error fails an app, except an answer the host gives while
 * the scenario stops it (host-errors.ts). Here the driver starts a real
 * process as its dev server and opens its page in Chromium, so the stop
 * request, the exit and the browser's response timing are the real ones.
 *
 * The stand-in host does what a dev server does when it gets SIGTERM: it
 * closes its `/__pyric/` routes first and keeps its listener for a while, so
 * a request a page makes in that window gets 404.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { AppRun, launchScenarioBrowser } from './driver.ts';

/** Stands in for `node_modules/vite/bin/vite.js`: the driver starts it with `--port <n>`. */
const STAND_IN_HOST = `
import { createServer } from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
let closing = false;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://stand-in').pathname;
  if (path === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>stand-in host</title>');
  if (path === '/__pyric/broken') return response.writeHead(500, { 'content-type': 'text/plain' }).end('the route broke');
  if (path === '/__pyric/missing') return response.writeHead(404, { 'content-type': 'text/plain' }).end('route missing');
  if (path === '/__pyric/unavailable') return response.writeHead(503, { 'content-type': 'text/plain' }).end('service unavailable');
  const servesRoute = path.startsWith('/__pyric/') && !closing;
  if (servesRoute) return response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  return response.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
});
server.listen(port, '127.0.0.1');
// Routes close at once; the listener stays until the process exits.
process.on('SIGTERM', () => { closing = true; setTimeout(() => process.exit(0), 600); });
`;

const NOT_COUNTED = 'response 404, from a host the scenario was stopping, not counted] POST';

let browser: Promise<Browser> | undefined;
const launch = () => (browser ??= launchScenarioBrowser());
const work: string[] = [];

afterAll(async () => {
  if (browser) await (await browser).close();
  for (const dir of work) rmSync(dir, { recursive: true, force: true });
});

/** A run whose `devServer()` starts the stand-in host. */
function standInRun(): AppRun {
  const dir = mkdtempSync(join(tmpdir(), 'stopping-host-'));
  work.push(dir);
  mkdirSync(join(dir, 'node_modules/vite/bin'), { recursive: true });
  mkdirSync(join(dir, 'home'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'stopping-host', private: true, type: 'module' }));
  writeFileSync(join(dir, 'node_modules/vite/bin/vite.js'), STAND_IN_HOST);
  return new AppRun('stopping-host', dir, join(dir, 'home'), launch);
}

/** Waits until `read()` is true, for the response events the browser sends after the page has its answer. */
async function eventually(read: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!read()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within 5 s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withRun(check: (run: AppRun) => Promise<void>): Promise<void> {
  const run = standInRun();
  try {
    await check(run);
  } finally {
    await run.close();
  }
}

describe('a host route error and a host the scenario stops', () => {
  test('a post the host answers 404 while the scenario stops it does not fail the app, and the browser log says so', () => withRun(async (run) => {
    const host = await run.devServer();
    const page = await run.page(host.url);
    const stopped = host.process.stop();
    // The page keeps posting, as a page reports its dropped connection, until the closing host answers.
    const status = await page.evaluate(async () => {
      for (;;) {
        const response = await fetch('/__pyric/diagnostics', { method: 'POST' });
        if (response.status !== 200) return response.status;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(status).toBe(404);
    await stopped;
    await eventually(() => run.browserLog.some((line) => line.includes('response 404')), 'the 404 reaching the browser log');
    expect(run.browserLog.filter((line) => line.includes('response 404'))).toEqual([
      expect.stringContaining(NOT_COUNTED),
    ]);
    expect(run.unexpectedHostErrors()).toEqual([]);
  }), 60_000);

  test('404 and 503 on a running host fail the app, and still do once the scenario stops the host', () => withRun(async (run) => {
    const host = await run.devServer();
    const page = await run.page(host.url);
    const statuses = await page.evaluate(async () => {
      const missing = await fetch('/__pyric/missing');
      const unavailable = await fetch('/__pyric/unavailable');
      return [missing.status, unavailable.status];
    });
    expect(statuses).toEqual([404, 503]);
    const expected = [
      '404 GET /__pyric/missing (during "setup"): route missing',
      '503 GET /__pyric/unavailable (during "setup"): service unavailable',
    ];
    await eventually(() => expected.every((line) => run.unexpectedHostErrors().includes(line)), 'the running host 404 and 503 counting as host errors');
    await host.process.stop();
    expect(run.unexpectedHostErrors()).toEqual(expected);
  }), 60_000);

  test('a 500 while the scenario stops the host still fails the app', () => withRun(async (run) => {
    const host = await run.devServer();
    const page = await run.page(host.url);
    const stopped = host.process.stop();
    // Wait until SIGTERM has closed routes (404), then hit /__pyric/broken (500) while the host is still stopping.
    await page.evaluate(async () => {
      for (;;) {
        const probe = await fetch('/__pyric/diagnostics', { method: 'POST' });
        if (probe.status === 404) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await fetch('/__pyric/broken');
    });
    await stopped;
    const failure = '500 GET /__pyric/broken (during "setup"): the route broke';
    await eventually(() => run.unexpectedHostErrors().includes(failure), 'the 500 during stop counting as a host error');
    expect(run.unexpectedHostErrors()).toEqual([failure]);
  }), 60_000);

  test('a host started again on the same port answers for itself: its 404 and 503 fail the app', () => withRun(async (run) => {
    const first = await run.devServer();
    const page = await run.page(first.url);
    await first.process.stop();
    await run.devServer({ port: first.port, name: 'restarted dev server' });
    const statuses = await page.evaluate(async () => {
      const missing = await fetch('/__pyric/missing');
      const unavailable = await fetch('/__pyric/unavailable');
      return [missing.status, unavailable.status];
    });
    expect(statuses).toEqual([404, 503]);
    const expected = [
      '404 GET /__pyric/missing (during "setup"): route missing',
      '503 GET /__pyric/unavailable (during "setup"): service unavailable',
    ];
    await eventually(() => expected.every((line) => run.unexpectedHostErrors().includes(line)), 'the restarted host 404 and 503 counting as host errors');
    expect(run.unexpectedHostErrors()).toEqual(expected);
  }), 60_000);
});
