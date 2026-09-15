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
    { service: 'rtdb', usage: { documentReads: 0, documentWrites: 0, documentDeletes: 0, payloadBytes: 2048, unmeasured: 0 }, coverage: 'partial', observed: true, untrackedMethods: ['onDisconnect'],
      methods: [method('get', 'read', 2, 2), method('update', 'write', 3, 0), method('onValue', 'listener', 0.2, 4, 1)] },
    { service: 'storage', coverage: 'unsupported', observed: false, methods: [], untrackedMethods: [] },
  ],
};

test('service list separates activity navigation from incident navigation without duplicate tables', () => {
  const view = rateView(snapshot, null, label, escape, undefined, '', new Map([['rtdb', 2]]));
  const document = new JSDOM(view.body).window.document;
  expect(view.title).toBe('Services');
  expect(document.querySelector('[data-inspect-rates="rtdb"]')?.getAttribute('aria-label')).toBe('Realtime Database');
  expect(document.querySelector('[data-rate-incidents="rtdb"]')?.textContent).toBe('2 incidents');
  expect(document.querySelector('table')).toBeNull();
  expect(document.querySelector('[data-usage]')).toBeNull();
  expect(document.body.textContent).toContain('storageNot measured');
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
  expect(document.body.textContent).toContain('Snapshot size is not billed download size.');
});

test('labels are escaped before rendering and stale selection returns to the service overview', () => {
  const view = rateView(snapshot, 'unknown', () => '<img src=x onerror="alert(1)">', escape);
  const document = new JSDOM(view.body).window.document;
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('.rate-service-list')).not.toBeNull();
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
  for (const key of ['reads', 'writes', 'deliveries']) expect(document.querySelector(`[data-usage=${key}]`)?.textContent).toBe('0');
  expect(document.activeElement).toBe(code);
  expect(code.scrollLeft).toBe(20);
  expect(document.querySelector('[data-rate-method="onValue"] [data-rate-calls]')?.textContent).toBe('0');
  expect(document.querySelector('[data-rate-method="onValue"] [data-rate-results]')?.textContent).toBe('0');
  expect(document.querySelector('[data-rate-listeners]')?.textContent).toBe('0');
});

test('missing usage evidence is not replaced with SDK counts', () => {
  const unknown = { ...snapshot, services: snapshot.services.map(service => ({ ...service, usage: undefined })) };
  const document = new JSDOM(rateView(unknown, 'rtdb', label, escape).body).window.document;
  expect(document.querySelector('[data-usage="payloadBytes"]')?.textContent).toBe('Not measured');
});
