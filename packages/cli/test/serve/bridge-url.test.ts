/**
 * The bridge WS URL must follow the page's own origin, not the server's baked-in
 * `localhost`, so it works over Tailscale / a LAN IP / `tailscale serve` (https).
 */
import { JSDOM } from 'jsdom';
import { describe, it, expect } from 'bun:test';
import * as bridgeUrlModule from '../../src/serve/entries/bridge-url.js';
import { readHostedTarget, stampHostedTarget } from '../../src/serve/runtime/hosted-target.js';

const { toPageOriginWsUrl } = bridgeUrlModule;

const loc = (href: string) => {
  const u = new URL(href);
  return { href, protocol: u.protocol, host: u.host };
};

// What the server bakes in (its own host).
const RAW = 'ws://localhost:5173/__pyric/sandbox';

describe('toPageOriginWsUrl', () => {
  it('uses the public proxy port for a hosted sandbox on the page origin', () => {
    expect(toPageOriginWsUrl(
      'ws://127.0.0.1:5217/__pyric/sandbox',
      loc('https://box.tail1234.ts.net:8457/'),
      'page-origin',
    )).toBe('wss://box.tail1234.ts.net:8457/__pyric/sandbox');
  });

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

  it('preserves the bridge server port when page runs on a different explicit port (two-server dev architecture)', () => {
    expect(toPageOriginWsUrl('ws://localhost:4288/__pyric/sandbox', loc('http://127.0.0.1:4289/'))).toBe(
      'ws://127.0.0.1:4288/__pyric/sandbox',
    );
  });

  it('preserves query parameters such as ?token= when re-anchoring', () => {
    expect(toPageOriginWsUrl(
      'ws://127.0.0.1:5217/__pyric/sandbox?token=abc-123',
      loc('https://box.tail1234.ts.net:8457/'),
      'page-origin',
    )).toBe('wss://box.tail1234.ts.net:8457/__pyric/sandbox?token=abc-123');
  });
});

describe('cookie-authenticated browser WebSocket URLs (no ?token=)', () => {
  it('omits withWsSessionToken and keeps readHostedTarget WebSocket URLs free of ?token=', () => {
    expect('withWsSessionToken' in bridgeUrlModule).toBe(false);

    const html = stampHostedTarget(
      '<!doctype html><html><head></head><body></body></html>',
      '/proj',
      undefined,
      'inst-1',
      'stamped-secret-token',
    );
    const dom = new JSDOM(html, { url: 'http://localhost:5173/', runScripts: 'dangerously' });
    const g = globalThis as Record<string, unknown>;
    const prevDoc = g.document;
    const prevLoc = g.location;
    const prevInit = g.__PYRIC_WORKER_INIT__;
    g.document = dom.window.document;
    g.location = dom.window.location;
    g.__PYRIC_WORKER_INIT__ = (dom.window as unknown as Record<string, unknown>).__PYRIC_WORKER_INIT__;
    try {
      expect(readHostedTarget()).toEqual({
        url: 'ws://localhost:5173/__pyric/sandbox',
        projectKey: '/proj',
      });
    } finally {
      g.document = prevDoc;
      g.location = prevLoc;
      g.__PYRIC_WORKER_INIT__ = prevInit;
    }
  });
});
