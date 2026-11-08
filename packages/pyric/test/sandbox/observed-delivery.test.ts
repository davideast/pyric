import { describe, expect, it } from 'bun:test';
import { activeListeners, initializeSandbox } from '../../src/sandbox/index.js';
import {
  isFirestoreDocumentPath,
  isLiveListenerDeliveryEvent,
  liveListenerIdOf,
  observedCallEvent,
  observedDeliveryOf,
  observedListenerEvent,
  observedListenerTarget,
  primeEventHistory,
  trimObservedPath,
} from '../../src/sandbox/internal/index.js';

describe('observed-delivery shared foundation', () => {
  it('trims leading and trailing slashes without altering interior segments', () => {
    expect(trimObservedPath('/rooms/r1/')).toBe('rooms/r1');
    expect(trimObservedPath('///items/i1/sub///')).toBe('items/i1/sub');
    expect(trimObservedPath('/')).toBe('');
    expect(trimObservedPath('')).toBe('');
  });

  it('classifies Firestore single-document paths by non-empty even segment count', () => {
    expect(isFirestoreDocumentPath('rooms/r1')).toBe(true);
    expect(isFirestoreDocumentPath('/rooms/r1/items/i1/')).toBe(true);
    expect(isFirestoreDocumentPath('rooms')).toBe(false);
    expect(isFirestoreDocumentPath('/rooms/r1/items')).toBe(false);
    expect(isFirestoreDocumentPath('')).toBe(false);
    expect(isFirestoreDocumentPath('/')).toBe(false);
    expect(isFirestoreDocumentPath('rooms//r1')).toBe(false);
  });

  it('maps observed Firestore and RTDB listener targets consistently', () => {
    expect(
      observedListenerTarget(
        { service: 'firestore', method: 'onSnapshot' },
        { target: 'rooms/r1' },
      ),
    ).toEqual({ kind: 'doc', path: 'rooms/r1' });
    expect(
      observedListenerTarget(
        { service: 'firestore', method: 'onSnapshot' },
        { target: 'rooms' },
      ),
    ).toEqual({ kind: 'query', path: 'rooms' });
    expect(
      observedListenerTarget(
        { service: 'rtdb', method: 'onChildRemoved' },
        { target: '/items' },
      ),
    ).toEqual({ kind: 'child_removed', path: '/items' });
  });

  it('identifies live listener delivery operation events and decodes detail.delivery', () => {
    const rtdbDelivery = {
      ...observedCallEvent({
        service: 'rtdb',
        method: 'onChildAdded',
        instance: 'demo-default-rtdb',
        path: '/items',
        at: 1_000,
        outcome: { status: 'ok' },
      }),
      detail: {
        listenerId: 'page:tab-1:l-1',
        delivery: {
          mode: 'delta',
          size: 1,
          paths: ['items/i1'],
          removedPaths: [],
        },
      },
    };
    expect(liveListenerIdOf(rtdbDelivery)).toBe('page:tab-1:l-1');
    expect(isLiveListenerDeliveryEvent(rtdbDelivery)).toBe(true);
    expect(observedDeliveryOf(rtdbDelivery)).toEqual({
      mode: 'delta',
      size: 1,
      paths: ['items/i1'],
      removedPaths: [],
    });

    const storageEvent = {
      ...observedCallEvent({
        service: 'storage',
        method: 'getBytes',
        bucket: 'demo.appspot.com',
        path: 'files/f1.txt',
        at: 1_100,
        outcome: { status: 'ok' },
      }),
      detail: { listenerId: 'forged-storage-id' },
    };
    expect(liveListenerIdOf(storageEvent)).toBeUndefined();
    expect(isLiveListenerDeliveryEvent(storageEvent)).toBe(false);

    expect(
      observedDeliveryOf({ detail: { delivery: { mode: 'unknown', size: 1, paths: [] } } }),
    ).toBeUndefined();
    expect(
      observedDeliveryOf({ detail: { delivery: { mode: 'delta', size: -1, paths: [] } } }),
    ).toBeUndefined();
  });

  it('closes un-detached observed live listeners when priming history from a prior host boot', () => {
    const attach = {
      ...observedListenerEvent({
        service: 'rtdb',
        method: 'onValue',
        instance: 'demo-default-rtdb',
        path: '/rooms/r1',
        at: 1_000,
        outcome: { status: 'ok' },
        listener: { phase: 'attach', id: 'l-1', target: '/rooms/r1' },
      }),
      listenerId: 'page:tab-1:l-1',
    };
    const sandbox = initializeSandbox();
    const primed = primeEventHistory(sandbox, [attach]);
    expect(primed).toBe(1);
    expect(activeListeners(sandbox.history())).toEqual([]);
  });
});
