import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'bun:test';
import { createFlowPainter, flowBadgeText } from '../../../src/serve/runtime/listener-flow-painter.js';
import { listenerHueIndex } from '../../../src/serve/runtime/listener-palette.js';
import { FLOW_STYLE_ATTRIBUTE } from '../../../src/serve/runtime/overlay-theme.js';
import type { FlowComponent, FlowSubtree } from '../../../src/serve/runtime/fiber-flow.js';

function setup() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="page">
      <div id="thread"><span id="bubble">hi</span></div>
      <div id="presence">1</div>
      <img id="avatar" />
    </div>
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
  const el = (selector: string): HTMLElement => doc.querySelector<HTMLElement>(selector)!;
  const marked = (): HTMLElement[] => [...doc.querySelectorAll<HTMLElement>('[data-pyric-flow]')];
  return { doc, container, painter, advance, timers, el, marked };
}

function component(element: Element, name: string, depth = 0): FlowComponent {
  return { name, element, depth, kind: 'component' };
}

function subtreeOf(components: FlowComponent[]): FlowSubtree {
  return { root: components[0] ?? null, components, leaves: components.slice(1) };
}

const paintOf = (page: ReturnType<typeof setup>, over?: Partial<{ listenerId: string; subtree: FlowSubtree }>) => ({
  listenerId: 'sub-1',
  label: 'ChatPage',
  target: 'conversations/c1/messages (query)',
  deliveryCount: 3,
  subtree: subtreeOf([
    component(page.el('#thread'), 'MessageThread'),
    component(page.el('#bubble'), 'MessageBubble', 1),
  ]),
  ...over,
});

describe('marking one delivery', () => {
  it('removes a detached photo badge and its timer when the image leaves the page', () => {
    const page = setup();
    const photo = page.el('#avatar');
    page.painter.paint(paintOf(page, { subtree: subtreeOf([component(photo, 'Photo')]) }));
    expect(page.container.querySelectorAll('[data-pyric-flow-badge]')).toHaveLength(1);
    photo.remove();
    page.painter.reposition();
    expect(page.container.querySelectorAll('[data-pyric-flow-badge]')).toHaveLength(0);
    expect(photo.hasAttribute('data-pyric-flow')).toBe(false);
    expect(page.timers.filter(timer => timer.at > 0)).toHaveLength(0);
    page.painter.dispose();
  });

  it('marks the elements themselves in the listener colour', () => {
    const page = setup();
    page.painter.paint(paintOf(page));

    expect(page.marked()).toEqual([page.el('#thread'), page.el('#bubble')]);
    for (const element of page.marked()) {
      expect(element.getAttribute('data-pyric-flow-listener')).toBe('sub-1');
      expect(element.getAttribute('data-pyric-flow-role')).toBe('component');
      expect(element.getAttribute('data-pyric-flow')).toBe(String(listenerHueIndex('sub-1')));
    }
    // Nothing is measured into the overlay: the container holds its stylesheet
    // and nothing else.
    expect(page.container.querySelectorAll('[data-pyric-flow-box]')).toHaveLength(0);

    page.painter.paint(paintOf(page, {
      listenerId: 'sub-2',
      subtree: subtreeOf([component(page.el('#presence'), 'PresenceBar')]),
    }));
    expect(listenerHueIndex('sub-2')).not.toBe(listenerHueIndex('sub-1'));
    expect(page.el('#presence').getAttribute('data-pyric-flow'))
      .toBe(String(listenerHueIndex('sub-2')));
  });

  it('marks a changed element no component named as a host', () => {
    const page = setup();
    page.painter.paint(paintOf(page, {
      subtree: subtreeOf([{ name: 'div#presence', element: page.el('#presence'), depth: 0, kind: 'host' }]),
    }));
    expect(page.el('#presence').getAttribute('data-pyric-flow-role')).toBe('host');
  });

  it('names the listener on the first element and the rest by themselves', () => {
    const page = setup();
    page.painter.paint(paintOf(page));

    expect(page.el('#thread').getAttribute('data-pyric-flow-label'))
      .toBe('ChatPage · conversations/c1/messages (query) · 3');
    expect(page.el('#bubble').getAttribute('data-pyric-flow-label')).toBe('MessageBubble');
  });

  it('spells the first label the way the Overview badge does', () => {
    expect(flowBadgeText({
      listenerId: 'sub-1',
      label: 'PresenceBar',
      target: 'status/u1',
      deliveryCount: 1,
      subtree: { root: null, components: [], leaves: [] },
    })).toBe('PresenceBar · status/u1 · 1');
  });

  it('falls back to a measured badge for an element that carries no pseudo one', () => {
    const page = setup();
    page.painter.paint(paintOf(page, {
      subtree: subtreeOf([component(page.el('#avatar'), 'img#avatar')]),
    }));

    // The outline is still on the element itself; only the words are measured.
    expect(page.el('#avatar').getAttribute('data-pyric-flow')).toBe(String(listenerHueIndex('sub-1')));
    expect(page.el('#avatar').hasAttribute('data-pyric-flow-label')).toBe(false);
    const badge = page.container.querySelector<HTMLElement>('[data-pyric-flow-badge]');
    expect(badge?.textContent).toBe('ChatPage · conversations/c1/messages (query) · 3');
    expect(badge?.dataset.listenerId).toBe('sub-1');
    expect(badge?.dataset.hue).toBe(String(listenerHueIndex('sub-1')));

    page.painter.clearListener('sub-1');
    expect(page.container.querySelectorAll('[data-pyric-flow-badge]')).toHaveLength(0);
  });

  it('puts the stylesheet in the document head, once', () => {
    const page = setup();
    expect(page.doc.head.querySelectorAll(`[${FLOW_STYLE_ATTRIBUTE}]`)).toHaveLength(1);
    createFlowPainter({ document: page.doc, container: page.container });
    expect(page.doc.querySelectorAll(`[${FLOW_STYLE_ATTRIBUTE}]`)).toHaveLength(1);
  });

  it('holds the marks dimmed once the fade is over, rather than taking them away', () => {
    const page = setup();
    page.painter.paint(paintOf(page));
    page.advance(3000);

    expect(page.marked()).toHaveLength(2);
    expect(page.marked().every((element) => element.hasAttribute('data-pyric-flow-retained')))
      .toBe(true);
  });

  it('takes a retained mark away when its listener is switched off', () => {
    const page = setup();
    page.painter.paint(paintOf(page));
    page.advance(3000);

    page.painter.clearListener('sub-1');
    expect(page.marked()).toHaveLength(0);
  });

  it('draws nothing for a delivery that rendered nothing', () => {
    const page = setup();
    page.painter.paint(paintOf(page, { subtree: { root: null, components: [], leaves: [] } }));
    expect(page.marked()).toHaveLength(0);
  });

  it('keeps two listeners apart and clears one at a time', () => {
    const page = setup();
    page.painter.paint(paintOf(page));
    page.painter.paint(paintOf(page, {
      listenerId: 'sub-2',
      subtree: subtreeOf([component(page.el('#presence'), 'PresenceBar')]),
    }));
    expect(page.marked()).toHaveLength(3);

    page.painter.clearListener('sub-1');
    expect(page.marked()).toEqual([page.el('#presence')]);
  });
});

describe('a burst of deliveries', () => {
  it('adds to what is on the page rather than replacing it', () => {
    const page = setup();
    page.painter.paint(paintOf(page, {
      subtree: subtreeOf([component(page.el('#thread'), 'MessageThread')]),
    }));
    page.advance(500);
    page.painter.paint(paintOf(page, {
      subtree: subtreeOf([component(page.el('#presence'), 'PresenceBar')]),
    }));
    page.advance(500);
    page.painter.paint(paintOf(page, {
      subtree: subtreeOf([component(page.el('#bubble'), 'MessageBubble')]),
    }));

    expect(page.marked()).toEqual([page.el('#thread'), page.el('#bubble'), page.el('#presence')]);
  });

  it('fades every mark on its own clock and keeps only the last delivery', () => {
    const page = setup();
    page.painter.paint(paintOf(page, {
      subtree: subtreeOf([component(page.el('#thread'), 'MessageThread')]),
    }));
    page.advance(1000);
    page.painter.paint(paintOf(page, {
      subtree: subtreeOf([component(page.el('#presence'), 'PresenceBar')]),
    }));

    // The first mark is three seconds old before the second one is.
    page.advance(2000);
    expect(page.marked()).toEqual([page.el('#presence')]);
    expect(page.el('#presence').hasAttribute('data-pyric-flow-retained')).toBe(false);

    page.advance(1000);
    // The newest delivery is what stays, dimmed.
    expect(page.marked()).toEqual([page.el('#presence')]);
    expect(page.el('#presence').hasAttribute('data-pyric-flow-retained')).toBe(true);
  });

  it('restarts the fade of an element that is marked again', () => {
    const page = setup();
    const one = paintOf(page, { subtree: subtreeOf([component(page.el('#thread'), 'MessageThread')]) });
    page.painter.paint(one);
    page.advance(2500);
    page.painter.paint(one);

    page.advance(1000);
    // The first clock would have ended by now; the restart is what keeps the
    // mark at full strength.
    expect(page.el('#thread').hasAttribute('data-pyric-flow-retained')).toBe(false);
    page.advance(2000);
    expect(page.el('#thread').hasAttribute('data-pyric-flow-retained')).toBe(true);
  });

  it('takes a whole burst away when its listener is switched off', () => {
    const page = setup();
    for (const selector of ['#thread', '#presence', '#bubble']) {
      page.painter.paint(paintOf(page, {
        subtree: subtreeOf([component(page.el(selector), selector)]),
      }));
      page.advance(100);
    }
    expect(page.marked()).toHaveLength(3);

    page.painter.clearListener('sub-1');
    expect(page.marked()).toHaveLength(0);
  });
});

describe('taking the marks off', () => {
  it('leaves no flow attributes behind on clear', () => {
    const page = setup();
    page.painter.paint(paintOf(page));
    page.painter.paint(paintOf(page, {
      listenerId: 'sub-2',
      subtree: subtreeOf([component(page.el('#avatar'), 'img#avatar')]),
    }));
    page.painter.clear();

    expect(page.doc.querySelectorAll('[data-pyric-flow], [data-pyric-flow-listener], [data-pyric-flow-role], [data-pyric-flow-label], [data-pyric-flow-fading], [data-pyric-flow-retained]'))
      .toHaveLength(0);
    expect(page.container.querySelectorAll('[data-pyric-flow-badge]')).toHaveLength(0);
  });

  it('leaves no flow attributes behind and cancels its timers on dispose', () => {
    const page = setup();
    page.painter.paint(paintOf(page));
    page.painter.dispose();

    expect(page.doc.querySelectorAll('[data-pyric-flow], [data-pyric-flow-label], [data-pyric-flow-listener], [data-pyric-flow-role]'))
      .toHaveLength(0);
    expect(page.timers.filter((timer) => timer.at > 0)).toHaveLength(0);
  });
});
