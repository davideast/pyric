/**
 * The bridge WS URL must follow the page's own origin, not the server's baked-in
 * `localhost`, so it works over Tailscale / a LAN IP / `tailscale serve` (https).
 */
import { describe, it, expect } from 'bun:test';
import { toPageOriginWsUrl } from '../../src/serve/entries/bridge-url.js';

const loc = (href: string) => {
  const u = new URL(href);
  return { href, protocol: u.protocol, host: u.host };
};

// What the server bakes in (its own host).
const RAW = 'ws://localhost:5173/__pyric/sandbox';

describe('toPageOriginWsUrl', () => {
  it('rewrites to wss + the tailnet host over https (tailscale serve, no port)', () => {
    expect(toPageOriginWsUrl(RAW, loc('https://box.tail1234.ts.net/app'))).toBe(
      'wss://box.tail1234.ts.net/__pyric/sandbox',
    );
  });

  it('rewrites to a LAN host over http and keeps its port', () => {
    expect(toPageOriginWsUrl(RAW, loc('http://192.168.1.5:5173/'))).toBe(
      'ws://192.168.1.5:5173/__pyric/sandbox',
    );
  });

  it('is a no-op for a real localhost page', () => {
    expect(toPageOriginWsUrl(RAW, loc('http://localhost:5173/'))).toBe(
      'ws://localhost:5173/__pyric/sandbox',
    );
  });
});
