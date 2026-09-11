/** Attributing a delivery to the elements its callback changed. */
import { afterEach, describe, expect, it } from 'bun:test';
import { configureListenerAttribution } from '../../../src/sandbox/attribution/attribution-mode.js';
import {
  recordEffectRegions,
  regionsFromRecords,
} from '../../../src/sandbox/attribution/effect-regions.js';
import { FakeElement, fakeDocument, installFakeDom } from '../../fixtures/fake-dom.js';

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  configureListenerAttribution('auto');
});

describe('regionsFromRecords', () => {
  it('de-duplicates selectors and keeps the order they were seen in', () => {
    const first = new FakeElement('div');
    first.id = 'a';
    const second = new FakeElement('div');
    second.id = 'b';
    const owner = regionsFromRecords([
      { target: first, addedNodes: [] },
      { target: second, addedNodes: [] },
      { target: first, addedNodes: [] },
    ]);
    expect(owner).toEqual({ kind: 'regions', selectors: ['#a', '#b'] });
  });

  it('reports nothing for an empty record list', () => {
    expect(regionsFromRecords([])).toBeUndefined();
  });
});

describe('recordEffectRegions', () => {
  it('names the element a callback mutated', () => {
    uninstall = installFakeDom();
    const panel = new FakeElement('section');
    panel.id = 'orders';
    fakeDocument.append(panel);
    const owner = recordEffectRegions(() => {
      panel.touchText();
    });
    expect(owner).toEqual({ kind: 'regions', selectors: ['#orders'] });
  });

  it('reports nothing for a callback that mutates nothing', () => {
    uninstall = installFakeDom();
    let ran = false;
    const owner = recordEffectRegions(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(owner).toBeUndefined();
  });

  it('sees nothing a later task does, because the window is synchronous', async () => {
    uninstall = installFakeDom();
    const panel = new FakeElement('section');
    panel.id = 'late';
    fakeDocument.append(panel);
    const owner = recordEffectRegions(() => {
      queueMicrotask(() => panel.touchText());
    });
    await Promise.resolve();
    expect(owner).toBeUndefined();
  });

  it('rethrows what the callback threw, after tearing the observer down', () => {
    uninstall = installFakeDom();
    expect(() => recordEffectRegions(() => {
      throw new Error('callback failed');
    })).toThrow('callback failed');
    const panel = new FakeElement('div');
    panel.id = 'after';
    const owner = recordEffectRegions(() => {
      panel.touchText();
    });
    expect(owner).toEqual({ kind: 'regions', selectors: ['#after'] });
  });

  it('is a pass-through with no DOM present', () => {
    let ran = false;
    const owner = recordEffectRegions(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(owner).toBeUndefined();
  });

  it('is a pass-through when attribution is off', () => {
    uninstall = installFakeDom();
    configureListenerAttribution('off');
    const panel = new FakeElement('div');
    panel.id = 'ignored';
    const owner = recordEffectRegions(() => {
      panel.touchText();
    });
    expect(owner).toBeUndefined();
  });
});
