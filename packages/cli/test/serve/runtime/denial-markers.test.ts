import { test, expect } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createDenialMarkers } from '../../../src/serve/runtime/denial-markers.js';
import type { ChipRequest } from '../../../src/serve/runtime/chip-traffic.js';
import type { SandboxEvent } from 'pyric/sandbox';

const request: ChipRequest = { id: 'denial-1', at: 1, service: 'firestore', method: 'get', path: 'private/item', verdict: 'denied', reason: 'signed out' };
const event = { kind: 'request', id: 'denial-1', at: 1, evalMs: 0, method: 'get', path: 'private/item', auth: null, result: 'deny', reasons: [] } satisfies SandboxEvent;

test('captured owner takes precedence over a related region and selects the exact request', () => {
  const document = new JSDOM('<body><div id="owner"></div><div id="related"></div></body>').window.document;
  let selected: ChipRequest | null = null;
  const markers = createDenialMarkers({ document, related: () => ({ sourceId: 'source', elements: [document.querySelector('#related')!] }), select: value => { selected = value; } });
  markers.show(request, { ...event, owners: [{ kind: 'tag', name: 'Owner', element: '#owner' }] });
  const badge = document.querySelector<HTMLButtonElement>('[data-pyric-listener-badge]')!;
  expect(badge.textContent).toBe('⚠ Read denied: private/item');
  expect(document.querySelectorAll('[data-pyric-listener-box]')).toHaveLength(1);
  badge.click();
  expect(selected).toEqual(request);
  markers.dispose();
  expect(document.querySelector('[data-pyric-denials]')).toBeNull();
});

test('missing targets and allowed requests never produce denial paint', () => {
  const document = new JSDOM('<body></body>').window.document;
  const markers = createDenialMarkers({ document, related: () => null, select: () => {} });
  markers.show(request, event);
  markers.show({ ...request, verdict: 'ok' }, event);
  expect(document.querySelector('[data-pyric-denials]')).toBeNull();
  markers.dispose();
});

test('invalid owner selectors fall back to a labeled related region', () => {
  const document = new JSDOM('<body><img id="related"></body>').window.document;
  const markers = createDenialMarkers({ document, related: () => ({ sourceId: 'source', elements: [document.querySelector('img')!] }), select: () => {} });
  markers.show(request, { ...event, owners: [{ kind: 'tag', name: 'Missing', element: '[' }] });
  expect(document.querySelector('[data-pyric-listener-badge]')!.textContent).toContain('related region');
  markers.dispose();
});
