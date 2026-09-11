import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { createFlowPainter, flowBadgeText } from '../../../src/serve/runtime/listener-flow-painter.js';
import { listenerColors } from '../../../src/serve/runtime/listener-palette.js';
import type { FlowSubtree } from '../../../src/serve/runtime/fiber-flow.js';

function setup() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="page"><div id="thread"><span id="bubble">hi</span></div></div>
  </body>`);
  const doc = dom.window.document;
  const container = doc.createElement('div');
  doc.body.append(container);
  const timers: Array<{ at: number; run: () => void }> = [];
  let now = 0;
  const painter = createFlowPainter({
    document: doc,
    container,
    fadeMs: 3000,
    schedule: (run, delayMs) => {
      const timer = { at: now + delayMs, run };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  });
  const advance = (ms: number): void => {
    now += ms;
    for (const timer of timers.filter((entry) => entry.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
  };
  return { doc, container, painter, advance, timers };
}

function subtree(doc: Document): FlowSubtree {
  const page = doc.querySelector('#page')!;
  const thread = doc.querySelector('#thread')!;
  return {
    root: { name: 'ChatPage', element: page, depth: 0 },
    components: [
      { name: 'ChatPage', element: page, depth: 0 },
      { name: 'MessageThread', element: thread, depth: 1 },
    ],
    leaves: [{ name: 'MessageThread', element: thread, depth: 1 }],
  };
}

const paintOf = (doc: Document) => ({
  listenerId: 'sub-1',
  label: 'ChatPage',
  target: 'conversations/c1/messages (query)',
  deliveryCount: 3,
  subtree: subtree(doc),
});

describe('painting one delivery', () => {
  it('draws a box for every component in the listener colour', () => {
    const page = setup();
    page.painter.paint(paintOf(page.doc));

    const boxes = [...page.container.querySelectorAll<HTMLElement>('[data-pyric-flow-box]')];
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box.dataset.listenerId).toBe('sub-1');
    expect(boxes.map((box) => box.dataset.component)).toEqual(['ChatPage', 'MessageThread']);
    // The page normalises the hue to rgb, so the colour is checked by the
    // property it agrees on: one colour across the subtree, another listener's.
    expect(boxes[0].style.borderColor).toBe(boxes[1].style.borderColor);
    expect(boxes[0].style.borderColor).not.toBe('');

    page.painter.paint({ ...paintOf(page.doc), listenerId: 'sub-2' });
    const other = page.container.querySelector<HTMLElement>('[data-pyric-flow-box][data-listener-id="sub-2"]');
    expect(listenerColors('sub-2').border).not.toBe(listenerColors('sub-1').border);
    expect(other?.style.borderColor).not.toBe(boxes[0].style.borderColor);
  });

  it('names the owner and target on the root badge and the component on the leaf', () => {
    const page = setup();
    page.painter.paint(paintOf(page.doc));

    const badge = page.container.querySelector('[data-pyric-flow-badge]');
    expect(badge?.textContent).toBe('ChatPage · conversations/c1/messages (query) · 3');
    expect(badge?.getAttribute('title')).toContain('rendered after a delivery');

    const leaf = page.container.querySelector('[data-pyric-flow-leaf-badge]');
    expect(leaf?.textContent).toBe('MessageThread');
  });

  it('spells the root badge the way the Overview badge does', () => {
    expect(flowBadgeText({
      listenerId: 'sub-1',
      label: 'PresenceBar',
      target: 'status/u1',
      deliveryCount: 1,
      subtree: { root: null, components: [], leaves: [] },
    })).toBe('PresenceBar · status/u1 · 1');
  });

  it('takes the boxes away once the fade is over', () => {
    const page = setup();
    page.painter.paint(paintOf(page.doc));
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(2);

    page.advance(3000);
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);
  });

  it('replaces the same listener rather than stacking on it', () => {
    const page = setup();
    page.painter.paint(paintOf(page.doc));
    page.painter.paint(paintOf(page.doc));
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(2);
  });

  it('keeps two listeners apart by colour and clears one at a time', () => {
    const page = setup();
    page.painter.paint(paintOf(page.doc));
    page.painter.paint({ ...paintOf(page.doc), listenerId: 'sub-2', label: 'PresenceBar' });
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(4);

    page.painter.clearListener('sub-1');
    const left = page.container.querySelectorAll<HTMLElement>('[data-pyric-flow-box]');
    expect(left).toHaveLength(2);
    expect([...left].every((box) => box.dataset.listenerId === 'sub-2')).toBe(true);
  });

  it('draws nothing for a delivery that rendered nothing', () => {
    const page = setup();
    page.painter.paint({
      ...paintOf(page.doc),
      subtree: { root: null, components: [], leaves: [] },
    });
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);
  });

  it('clears everything and cancels its timers on dispose', () => {
    const page = setup();
    page.painter.paint(paintOf(page.doc));
    page.painter.dispose();
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);
    expect(page.timers.filter((timer) => timer.at > 0)).toHaveLength(0);
  });
});
