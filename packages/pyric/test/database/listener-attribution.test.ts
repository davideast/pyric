/**
 * What a Realtime Database listener event says about who owns the listener.
 *
 * Same three owner kinds as Firestore, on the same events, through
 * `onValue`'s own `ListenOptions`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { getDatabase, onValue, ref, set } from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import type { SandboxEvent } from 'pyric/sandbox';
import { configureListenerAttribution } from 'pyric/sandbox/internal';
import { setData, setRules } from 'pyric/sandbox/database';
import { FakeElement, fakeDocument, installFakeDom } from '../fixtures/fake-dom.js';

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  configureListenerAttribution('auto');
});

type ListenerEvent = Extract<SandboxEvent, { kind: 'listener' }>;

function setup() {
  const sandbox = initializeSandbox();
  setRules(sandbox, { rules: { '.read': true, '.write': true } });
  setData(sandbox, { '/rooms/r1': { name: 'lobby' } });
  const events: SandboxEvent[] = [];
  sandbox.onEvent((event) => events.push(event));
  return { sandbox, db: getDatabase(sandbox), events };
}

function listenerEvents(events: SandboxEvent[], phase: ListenerEvent['phase']): ListenerEvent[] {
  return events.filter(
    (event): event is ListenerEvent => event.kind === 'listener' && event.phase === phase,
  );
}

describe('creation frame', () => {
  it('names the file that called onValue', () => {
    const { db, events } = setup();
    const unsubscribe = onValue(ref(db, '/rooms/r1'), () => {});

    const owners = listenerEvents(events, 'attach')[0]?.owners ?? [];
    const frame = owners.find((owner) => owner.kind === 'frame');
    expect(frame).toBeDefined();
    if (frame?.kind !== 'frame') throw new Error('expected a frame owner');
    expect(frame.file).toContain('listener-attribution.test.ts');
    expect(frame.file).not.toContain('/database/sandbox/');
    unsubscribe();
  });

  it('records no owners at all under production mode', () => {
    configureListenerAttribution('off');
    const { db, events } = setup();
    const unsubscribe = onValue(ref(db, '/rooms/r1'), () => {});

    expect(listenerEvents(events, 'attach')[0]?.owners).toBeUndefined();
    unsubscribe();
  });
});

describe('explicit owner tag', () => {
  it('records a caller-supplied name from the listen options', () => {
    const { db, events } = setup();
    const unsubscribe = onValue(ref(db, '/rooms/r1'), () => {}, { owner: 'room-header' });

    const owners = listenerEvents(events, 'attach')[0]?.owners ?? [];
    expect(owners).toContainEqual({ kind: 'tag', name: 'room-header' });
    unsubscribe();
  });

  it('records an element as its tag name and selector', () => {
    const { db, events } = setup();
    const element = new FakeElement('header');
    element.id = 'room';
    const unsubscribe = onValue(ref(db, '/rooms/r1'), () => {}, { owner: element });

    const owners = listenerEvents(events, 'attach')[0]?.owners ?? [];
    expect(owners).toContainEqual({ kind: 'tag', name: 'header', element: '#room' });
    unsubscribe();
  });
});

describe('effect attribution on delivery', () => {
  it('names the element the callback mutated', () => {
    uninstall = installFakeDom();
    const { db, events } = setup();
    const panel = new FakeElement('div');
    panel.id = 'room-name';
    fakeDocument.append(panel);

    const unsubscribe = onValue(ref(db, '/rooms/r1'), () => {
      panel.touchText();
    });

    const delivery = listenerEvents(events, 'delivery')[0];
    expect(delivery?.owners).toEqual([{ kind: 'regions', selectors: ['#room-name'] }]);
    unsubscribe();
  });

  it('records no regions for a callback that mutates nothing', () => {
    uninstall = installFakeDom();
    const { db, events } = setup();
    const unsubscribe = onValue(ref(db, '/rooms/r1'), () => {});

    expect(listenerEvents(events, 'delivery')[0]?.owners).toBeUndefined();
    unsubscribe();
  });
});

describe('delivery fidelity', () => {
  it('delivers the same values, in the same order, with attribution on', async () => {
    uninstall = installFakeDom();
    const { db, events } = setup();
    const seen: unknown[] = [];
    const unsubscribe = onValue(ref(db, '/rooms/r1'), (snapshot) => {
      seen.push(snapshot.val());
    });
    await set(ref(db, '/rooms/r1'), { name: 'hall' });

    expect(seen).toEqual([{ name: 'lobby' }, { name: 'hall' }]);
    expect(listenerEvents(events, 'delivery')).toHaveLength(2);
    unsubscribe();
  });
});
