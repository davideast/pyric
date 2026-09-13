import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { createListenerOverlay } from '../../../src/serve/runtime/listener-overlay.js';
import { listenerHueIndex } from '../../../src/serve/runtime/listener-palette.js';
import { OVERLAY_STYLE_ATTRIBUTE } from '../../../src/serve/runtime/overlay-theme.js';
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
  it('remeasures fallback boxes and followers on nested non-bubbling scroll, then stops on dispose', () => {
    const doc = page();
    const target = doc.querySelector<HTMLElement>('#todos')!;
    let top = 240;
    target.getBoundingClientRect = () => ({ x: 20, y: top, left: 20, top, right: 120, bottom: top + 80, width: 100, height: 80, toJSON: () => ({}) });
    const overlay = createListenerOverlay({ document: doc });
    overlay.update([outline({})]);
    const box = boxes(doc)[0]!;
    let followed = 0;
    overlay.onReposition(() => { followed++; });
    top = 70;
    target.dispatchEvent(new doc.defaultView!.Event('scroll', { bubbles: false }));
    expect(box.style.top).toBe('70px');
    expect(followed).toBe(1);
    overlay.dispose();
    top = 10;
    target.dispatchEvent(new doc.defaultView!.Event('scroll', { bubbles: false }));
    expect(followed).toBe(1);
  });

  it('removes detached targets when geometry is refreshed', () => {
    const doc = page();
    const overlay = createListenerOverlay({ document: doc });
    overlay.update([outline({})]);
    doc.querySelector('#todos')!.remove();
    overlay.reposition();
    expect(boxes(doc)).toHaveLength(0);
    overlay.dispose();
  });

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

  it('says what each box and badge is, and leaves the drawing to the stylesheet', () => {
    const doc = page();
    const overlay = createListenerOverlay({ document: doc });
    overlay.update([outline({ incident: { pattern: 'duplicate-listener', count: 2 } })]);

    const box = boxes(doc)[0]!;
    expect(box.dataset.pyricRole).toBe('region');
    expect(box.dataset.listenerId).toBe('l1');
    expect(box.dataset.listenerTarget).toBe('todos');
    expect(box.dataset.hue).toBe(String(listenerHueIndex('l1')));
    expect(box.dataset.incident).toBe('duplicate-listener');
    // Geometry is measured, so it stays inline. Nothing else does.
    expect([...box.style]).toEqual(['left', 'top', 'width', 'height']);

    const badge = doc.querySelector<HTMLElement>('[data-pyric-listener-badge]')!;
    expect(badge.dataset.pyricRole).toBe('badge');
    expect(badge.dataset.hue).toBe(box.dataset.hue);
    expect([...badge.style]).toEqual([]);
    overlay.dispose();
  });

  it('says which painting mode the container is in', () => {
    const doc = page();
    const overlay = createListenerOverlay({ document: doc });
    const container = doc.querySelector<HTMLElement>('[data-pyric-listener-overlay]')!;
    expect(container.getAttribute('data-pyric-mode')).toBe('overview');
    overlay.setMode('flow');
    expect(container.getAttribute('data-pyric-mode')).toBe('flow');
    overlay.dispose();
  });

  it('injects the stylesheet once, however many times it redraws', () => {
    const doc = page();
    const overlay = createListenerOverlay({ document: doc });
    overlay.update([outline({})]);
    overlay.update([outline({}), outline({ listenerId: 'l2', selectors: ['#profile'] })]);
    expect(doc.querySelectorAll(`[${OVERLAY_STYLE_ATTRIBUTE}]`)).toHaveLength(1);
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
