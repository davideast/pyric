import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { createListenerOverlay } from '../../../src/serve/runtime/listener-overlay.js';
import type { ListenerOutline } from '../../../src/serve/runtime/listener-outline-model.js';

function outline(overrides: Partial<ListenerOutline>): ListenerOutline {
  return {
    listenerId: 'l1',
    label: 'TodoList',
    target: 'todos',
    isQuery: true,
    service: 'firestore',
    deliveryCount: 3,
    selectors: ['#todos'],
    incident: null,
    ...overrides,
  };
}

function page(): Document {
  const dom = new JSDOM(
    '<!doctype html><body><div id="todos"></div><div id="profile"></div></body>',
    { url: 'http://localhost/' },
  );
  return dom.window.document;
}

function boxes(doc: Document): HTMLElement[] {
  return [...doc.querySelectorAll<HTMLElement>('[data-pyric-listener-box]')];
}

describe('createListenerOverlay', () => {
  it('draws one box per outlined listener with its label, target, and delivery count', () => {
    const doc = page();
    const overlay = createListenerOverlay({ document: doc });
    overlay.update([
      outline({}),
      outline({ listenerId: 'l2', label: 'Profile', target: 'users/u1', isQuery: false, deliveryCount: 1, selectors: ['#profile'] }),
    ]);

    const drawn = boxes(doc);
    expect(drawn).toHaveLength(2);
    expect(drawn[0]?.dataset.listenerId).toBe('l1');
    expect(drawn[0]?.textContent).toContain('TodoList');
    expect(drawn[0]?.textContent).toContain('todos (query)');
    expect(drawn[0]?.textContent).toContain('3');
    expect(drawn[1]?.textContent).toContain('users/u1');
    expect(drawn[1]?.textContent).not.toContain('(query)');
    overlay.dispose();
  });

  it('removes a box when its listener is gone from the next update', () => {
    const doc = page();
    const overlay = createListenerOverlay({ document: doc });
    overlay.update([outline({}), outline({ listenerId: 'l2', selectors: ['#profile'] })]);
    expect(boxes(doc)).toHaveLength(2);

    overlay.update([outline({})]);
    expect(boxes(doc).map((box) => box.dataset.listenerId)).toEqual(['l1']);
    overlay.dispose();
  });

  it('marks a badge whose listener is part of an incident with the incident count', () => {
    const doc = page();
    const overlay = createListenerOverlay({ document: doc });
    overlay.update([outline({ incident: { pattern: 'duplicate-listener', count: 2 } })]);

    const badge = doc.querySelector<HTMLElement>('[data-pyric-listener-badge]');
    expect(badge?.dataset.incident).toBe('duplicate-listener');
    expect(badge?.textContent).toContain('duplicate ×2');
    overlay.dispose();
  });

  it('draws nothing for a listener whose selectors match no element', () => {
    const doc = page();
    const overlay = createListenerOverlay({ document: doc });
    overlay.update([outline({ selectors: ['#missing'] }), outline({ listenerId: 'l2', selectors: [] })]);
    expect(boxes(doc)).toHaveLength(0);
    overlay.dispose();
  });

  it('reports the clicked badge to the caller', () => {
    const doc = page();
    const selected: string[] = [];
    const overlay = createListenerOverlay({
      document: doc,
      onSelect: (picked) => {
        selected.push(picked.listenerId);
      },
    });
    overlay.update([outline({})]);
    doc.querySelector<HTMLElement>('[data-pyric-listener-badge]')?.click();
    expect(selected).toEqual(['l1']);
    overlay.dispose();
  });

  it('removes its container on dispose', () => {
    const doc = page();
    const overlay = createListenerOverlay({ document: doc });
    overlay.update([outline({})]);
    overlay.dispose();
    expect(doc.querySelector('[data-pyric-listener-overlay]')).toBeNull();
  });
});
