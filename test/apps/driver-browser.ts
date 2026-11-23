/**
 * Chromium launcher, local-only host resolver rules, external request and
 * WebSocket context guard, and HTTP/HTTPS readiness probes for app scenarios.
 */
import { get as httpsGet } from 'node:https';
import { chromium, type Browser, type BrowserContext, type LaunchOptions } from '@playwright/test';
import { retainBrowserChildren } from './browser-children.ts';
import { LOCAL_HOSTS } from './host-errors.ts';

/**
 * Whether an HTTPS dev server answers 2xx at `url`. Its certificate is
 * self-signed, so this one readiness probe, made by the test, skips verifying it.
 */
function answersOverHttps(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = httpsGet(url, { rejectUnauthorized: false, timeout: 2_000 }, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      response.on('end', () => resolve(status >= 200 && status < 300));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

export async function answers(url: string): Promise<boolean> {
  const isHttps = url.startsWith('https:');
  if (isHttps) return answersOverHttps(url);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.arrayBuffer();
    return response.ok;
  } catch (error) {
    if (error instanceof Error) return false;
    return false;
  }
}

// At load, not at launch: a scenario can also call chromium.launch itself.
retainBrowserChildren();

/**
 * Chromium's resolver rules for scenario pages: every name and address but
 * the local ones fails to resolve. The routes in `browser()` block and log;
 * these rules stop what no route sees, such as a WebSocket a worker opens,
 * before it leaves the machine (#1606).
 */
export const LOCAL_ONLY_RESOLVER_RULES = [
  'MAP * ~NOTFOUND',
  ...[...LOCAL_HOSTS].map((host) => `EXCLUDE ${host.replace(/^\[(.*)\]$/, '$1')}`),
].join(', ');

/**
 * Launches the Chromium that every scenario's pages run in, headless, with
 * the local-only resolver rules added to any `args` in `options`. A scenario
 * that needs its own browser, such as one with the back-forward cache
 * enabled, launches it here and guards its contexts with `guardContext`.
 */
export function launchScenarioBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const args = [...(options.args ?? []), `--host-resolver-rules=${LOCAL_ONLY_RESOLVER_RULES}`];
  return chromium.launch({ headless: true, ...options, args });
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A WebSocket URL to any host but the local ones. It is a RegExp, not a
 * function, so Playwright connects a local socket in the page itself instead
 * of relaying each of its frames through the driver.
 */
const EXTERNAL_WEBSOCKET = new RegExp(`^wss?://(?!(?:${[...LOCAL_HOSTS].map(escapeRegExp).join('|')})(?::\\d+)?/)`);

/**
 * Blocks and logs to `log` every request and page WebSocket from `context`
 * to a host other than the local ones. Register it before a scenario's own
 * routes: the first route registered runs last, so those answer first.
 */
export async function guardContext(context: BrowserContext, log: string[]): Promise<void> {
  await context.route(() => true, async (route) => {
    const url = new URL(route.request().url());
    const isLocal = LOCAL_HOSTS.has(url.hostname) || url.protocol === 'data:' || url.protocol === 'blob:';
    if (isLocal) return route.continue();
    log.push(`[blocked external request] ${route.request().method()} ${url.href}`);
    return route.abort('blockedbyclient');
  });
  // `route` never sees a WebSocket. The page sees the connection close without opening.
  await context.routeWebSocket(EXTERNAL_WEBSOCKET, async (socket) => {
    log.push(`[blocked external WebSocket] ${socket.url()}`);
    await socket.close({ code: 1008, reason: 'blocked by the app scenario driver' });
  });
}
