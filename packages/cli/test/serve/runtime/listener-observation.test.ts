import { expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';

it('gives a page one observation when two copies of the module load', async () => {
  const first = await import('../../../src/serve/runtime/listener-observation.ts?copy=first');
  const second = await import('../../../src/serve/runtime/listener-observation.ts?copy=second');
  expect(first.pageListenerObservation).not.toBe(second.pageListenerObservation);
  const dom = new JSDOM('<!doctype html><head><meta name="pyric-runtime-chip" content="collapsed"></head><body></body>', { url: 'http://localhost/' });
  const document = dom.window.document;
  const observation = first.pageListenerObservation(document);
  try {
    expect(observation).not.toBeNull();
    expect(second.pageListenerObservation(document)).toBe(observation);
  } finally {
    observation?.dispose();
    dom.window.close();
  }
  const other = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const fresh = second.pageListenerObservation(other.window.document);
  expect(fresh).not.toBe(observation);
  fresh?.dispose();
  other.window.close();
});
