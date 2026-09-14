import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { SdkMethodRate, SdkRateSnapshot } from 'pyric/sandbox/internal';
import { rateView, refreshRateView } from '../../../src/serve/runtime/chip-rates.js';

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const label = (service: string) => service === 'rtdb' ? 'Realtime Database' : service;
const method = (name: string, category: SdkMethodRate['category'], calls: number, deliveries: number, active = 0): SdkMethodRate => ({
  method: name, category, callsPerSecond: calls, deliveriesPerSecond: deliveries,
  activeListeners: active, observed: true, buckets: [],
});
const snapshot: SdkRateSnapshot = {
  monotonicAt: 1000, windowSeconds: 5,
  services: [
    { service: 'rtdb', coverage: 'partial', observed: true, untrackedMethods: ['onDisconnect'],
      methods: [method('get', 'read', 2, 2), method('update', 'write', 3, 0), method('onValue', 'listener', 0.2, 4, 1)] },
    { service: 'storage', coverage: 'unsupported', observed: false, methods: [], untrackedMethods: [] },
  ],
};

test('service summaries distinguish read results from listener updates and unsupported usage', () => {
  const view = rateView(snapshot, null, label, escape);
  const document = new JSDOM(view.body).window.document;
  expect(view.detail).toBe('5-second average');
  expect(document.querySelector('[data-rate-reads]')?.textContent).toBe('2');
  expect(document.querySelector('[data-rate-writes]')?.textContent).toBe('3');
  expect(document.querySelector('[data-rate-updates]')?.textContent).toBe('4');
  const storage = document.querySelector('[data-rate-service="storage"]');
  expect(storage?.textContent).toContain('Not measured');
  expect(storage?.querySelector('button')).toBeNull();
  expect(storage?.querySelector('[data-rate-reads]')).toBeNull();
});

test('method detail shows listener gauges and coverage without implying write data results', () => {
  const view = rateView(snapshot, 'rtdb', label, escape);
  const document = new JSDOM(view.body).window.document;
  expect(view.title).toBe('Realtime Database');
  expect(document.querySelector('[data-rate-listeners]')?.textContent).toBe('1');
  const listener = document.querySelector('[data-rate-method="onValue"]');
  expect(listener?.querySelector('[data-rate-calls]')?.textContent).toBe('0.2');
  expect(listener?.querySelector('[data-rate-results]')?.textContent).toBe('4');
  expect(listener?.querySelector('[data-rate-active]')?.textContent).toBe('1');
  expect(document.querySelector('[data-rate-method="update"] [aria-label="No data result"]')).not.toBeNull();
  expect(document.querySelector('[data-rate-method="onDisconnect"]')?.textContent).toContain('Not measured');
  expect(document.body.textContent).toContain('Listed SDK methods');
});

test('labels are escaped before rendering and stale selection returns to the service overview', () => {
  const view = rateView(snapshot, 'unknown', () => '<img src=x onerror="alert(1)">', escape);
  const document = new JSDOM(view.body).window.document;
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('[data-service-rates]')).not.toBeNull();
  expect(rateView(snapshot, 'storage', label, escape).body).not.toContain('data-rate-listeners');
});

test('idle refresh updates numbers without replacing a focused method or its scroll position', () => {
  const document = new JSDOM(rateView(snapshot, 'rtdb', label, escape).body).window.document;
  const code = document.querySelector<HTMLElement>('[data-rate-method="onValue"] code')!;
  code.focus();
  code.scrollLeft = 20;
  const idle: SdkRateSnapshot = {
    ...snapshot,
    services: snapshot.services.map(service => ({ ...service,
      methods: service.methods.map(entry => ({ ...entry, callsPerSecond: 0, deliveriesPerSecond: 0, activeListeners: 0 })),
    })),
  };
  refreshRateView(document, idle);
  expect(document.activeElement).toBe(code);
  expect(code.scrollLeft).toBe(20);
  expect(document.querySelector('[data-rate-method="onValue"] [data-rate-calls]')?.textContent).toBe('0');
  expect(document.querySelector('[data-rate-method="onValue"] [data-rate-results]')?.textContent).toBe('0');
  expect(document.querySelector('[data-rate-listeners]')?.textContent).toBe('0');
});
