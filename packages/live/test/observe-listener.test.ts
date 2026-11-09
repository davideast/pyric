import { describe, expect, test } from 'bun:test';
import {
  createListenerLifecycle,
  mintListenerId,
  subscribeWithLifecycle,
  wrapEndingUnsubscribe,
} from '../src/observe-listener.js';
import type { LiveCallOutcome, ObservedSite } from '../src/observe.js';

describe('observe-listener lifecycle helpers', () => {
  test('mints distinct realm-prefixed listener ids', () => {
    const first = mintListenerId();
    const second = mintListenerId();
    expect(first).toMatch(/^l-[0-9a-f]{8}-\d+$/);
    expect(second).not.toBe(first);
  });

  test('records attached once and detached once across external and unsubscribe teardown', () => {
    const events: Array<{ outcome: LiveCallOutcome; id?: string }> = [];
    let closedCount = 0;
    let triggerExternalDetach: (() => void) | undefined;

    const site: ObservedSite = {
      module: 'firebase/database',
      name: 'onValue',
      observer: () => undefined,
      sdkVersion: '12.0.0',
      client: 'page',
      listenerOf: () => ({ target: '/rooms/r1', key: '["default","/rooms/r1","default"]' }),
      listenerAttached: (_name, _args, detach) => {
        triggerExternalDetach = detach;
        return () => undefined;
      },
      listenerOnlyOnce: () => true,
    };

    const hooks = {
      report: (s: ObservedSite, outcome: LiveCallOutcome) => {
        events.push({ outcome, id: s.listener?.id });
        return undefined;
      },
      closeActivity: () => {
        closedCount += 1;
      },
      endListener: (s: ObservedSite) => s.endListener?.(),
    };

    const lifecycle = createListenerLifecycle(site, ['ref', () => undefined], hooks);
    expect(lifecycle).toBeDefined();
    expect(lifecycle!.fields.detachesOnDelivery).toBe(true);

    const boundSite: ObservedSite = { ...site, ...lifecycle!.fields };
    const rawUnsub = subscribeWithLifecycle(
      boundSite,
      lifecycle!,
      { real: () => () => 'stopped', self: undefined, args: [], appArgs: [] },
      hooks.report,
    );
    const wrapped = wrapEndingUnsubscribe(boundSite, rawUnsub, hooks.endListener) as () => string;

    triggerExternalDetach?.();
    expect(wrapped()).toBe('stopped');
    expect(events.map((e) => e.outcome)).toEqual(['attached', 'detached']);
    expect(events[0]!.id).toBe(events[1]!.id);
    expect(closedCount).toBe(1);
  });
});
