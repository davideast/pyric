import type { BrowserDiagnosticReport } from '../../../src/serve/runtime/diagnostics-report.js';
import { expect, test } from '@playwright/test';
import { startSoakServe } from '../soak/harness.js';

test('agents see browser startup and close codes even when the sandbox socket never attaches', async ({ browser }) => {
  const fixture = await startSoakServe({ flags: ['--hosted', '--no-capture'] });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.routeWebSocket('**/__pyric/sandbox', socket => socket.close({ code: 1008, reason: 'test refusal' }));
    await page.goto(fixture.info.url);
    const read = async (): Promise<{ server: { http: string }; clients: BrowserDiagnosticReport[] }> => (await page.request.get(`${fixture.info.url}/__pyric/diagnostics`)).json();
    await expect.poll(async () => {
      const report = await read();
      return report.clients.flatMap((client) => client.events).some((event) => event.phase === 'socket-close' && event.code === 1008);
    }).toBe(true);
    const report = await read();
    expect(report.server.http).toBe('responding');
    expect(report.clients.flatMap((client) => client.events).map((event) => event.phase)).toContain('init-ready');
    const recovered = await context.newPage();
    await recovered.goto(fixture.info.url);
    await expect.poll(async () => {
      const report = await read();
      return report.clients.some((client) => client.events.some((event) => event.phase === 'attached'));
    }).toBe(true);
  } finally {
    await context.close();
    await fixture.stop();
  }
});

test('local diagnostics survive HTTP reporting failure and upload when reporting recovers', async ({ browser }) => {
  const fixture = await startSoakServe({ flags: ['--hosted', '--no-capture'] });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route('**/__pyric/diagnostics', route => route.abort());
    await page.routeWebSocket('**/__pyric/sandbox', socket => socket.close({ code: 1008 }));
    await page.goto(fixture.info.url);
    await expect.poll(() => page.evaluate(() => globalThis.__pyricDiagnostics?.getSnapshot().events.some(event => event.phase === 'socket-close'))).toBe(true);
    await page.unroute('**/__pyric/diagnostics');
    await expect.poll(async () => {
      await page.evaluate(() => globalThis.__pyricDiagnostics?.flush());
      const report = await (await page.request.get(`${fixture.info.url}/__pyric/diagnostics`)).json();
      return report.clients.length;
    }).toBeGreaterThan(0);
  } finally {
    await context.close();
    await fixture.stop();
  }
});

test('startup diagnostics report init HTTP failure without waiting for the sandbox', async ({ browser }) => {
  const fixture = await startSoakServe({ flags: ['--hosted', '--no-capture'] });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route('**/__pyric/init.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
    await page.goto(fixture.info.url);
    await expect.poll(async () => {
      const report: { clients: BrowserDiagnosticReport[] } = await (await page.request.get(`${fixture.info.url}/__pyric/diagnostics`)).json();
      return report.clients.some(client => client.events.some(event => event.phase === 'init-failed' && event.code === 503));
    }).toBe(true);
  } finally {
    await context.close();
    await fixture.stop();
  }
});
