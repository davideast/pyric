/**
 * What a Firestore listener event says about who owns the listener.
 *
 * Attribution rides on pyric's own diagnostic events and never on the
 * snapshot: these probes assert the events, and assert that the callback
 * still sees exactly what it saw before.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { collection, getFirestore, onSnapshot, setDoc, doc } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import type { SandboxEvent } from 'pyric/sandbox';
import { configureListenerAttribution } from 'pyric/sandbox/internal';
import { seedDocuments } from 'pyric/sandbox/firestore';
import { FakeElement, fakeDocument, installFakeDom } from '../fixtures/fake-dom.js';

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  configureListenerAttribution('auto');
});

function setup() {
  const sandbox = initializeSandbox();
  seedDocuments(sandbox, { 'orders/o1': { total: 10 } });
  const events: SandboxEvent[] = [];
  sandbox.onEvent((event) => events.push(event));
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  return { sandbox, db, events };
}

function attachEvents(events: SandboxEvent[]): Array<Extract<SandboxEvent, { kind: 'listener_attach' }>> {
  return events.filter((event) => event.kind === 'listener_attach');
}

function deliveryEvents(events: SandboxEvent[]): Array<Extract<SandboxEvent, { kind: 'snapshot_delivery' }>> {
  return events.filter((event) => event.kind === 'snapshot_delivery');
}

describe('creation frame', () => {
  it('names the file that called onSnapshot, not a pyric file', async () => {
    const { db, events } = setup();
    const unsubscribe = onSnapshot(collection(db, 'orders'), () => {});
    await Promise.resolve();

    const owners = attachEvents(events)[0]?.owners ?? [];
    const frame = owners.find((owner) => owner.kind === 'frame');
    expect(frame).toBeDefined();
    if (frame?.kind !== 'frame') throw new Error('expected a frame owner');
    expect(frame.file).toContain('listener-attribution.test.ts');
    expect(frame.file).not.toContain('/firestore/sandbox/');
    unsubscribe();
  });

  it('records no owners at all under production mode', async () => {
    configureListenerAttribution('off');
    const { db, events } = setup();
    const unsubscribe = onSnapshot(collection(db, 'orders'), () => {});
    await Promise.resolve();

    expect(attachEvents(events)[0]?.owners).toBeUndefined();
    unsubscribe();
  });
});

describe('explicit owner tag', () => {
  it('records a caller-supplied name', async () => {
    const { db, events } = setup();
    const unsubscribe = onSnapshot(
      collection(db, 'orders'),
      { owner: 'orders-table' },
      () => {},
    );
    await Promise.resolve();

    const owners = attachEvents(events)[0]?.owners ?? [];
    expect(owners).toContainEqual({ kind: 'tag', name: 'orders-table' });
    unsubscribe();
  });

  it('records an element as its tag name and selector', async () => {
    const { db, events } = setup();
    const element = new FakeElement('table');
    element.id = 'orders';
    const unsubscribe = onSnapshot(
      collection(db, 'orders'),
      { owner: element },
      () => {},
    );
    await Promise.resolve();

    const owners = attachEvents(events)[0]?.owners ?? [];
    expect(owners).toContainEqual({ kind: 'tag', name: 'table', element: '#orders' });
    unsubscribe();
  });
});

describe('effect attribution on delivery', () => {
  it('names the element the callback mutated', async () => {
    uninstall = installFakeDom();
    const { db, events } = setup();
    const panel = new FakeElement('tbody');
    panel.id = 'orders-body';
    fakeDocument.append(panel);

    const unsubscribe = onSnapshot(collection(db, 'orders'), () => {
      panel.touchText();
    });
    await Promise.resolve();

    const delivery = deliveryEvents(events)[0];
    expect(delivery?.owners).toEqual([{ kind: 'regions', selectors: ['#orders-body'] }]);
    unsubscribe();
  });

  it('records no regions for a callback that mutates nothing', async () => {
    uninstall = installFakeDom();
    const { db, events } = setup();
    const unsubscribe = onSnapshot(collection(db, 'orders'), () => {});
    await Promise.resolve();

    expect(deliveryEvents(events)[0]?.owners).toBeUndefined();
    unsubscribe();
  });
});

describe('delivery fidelity', () => {
  it('delivers the same snapshots, in the same order, with attribution on', async () => {
    uninstall = installFakeDom();
    const { db, events } = setup();
    const sizes: number[] = [];
    const unsubscribe = onSnapshot(collection(db, 'orders'), (snapshot) => {
      sizes.push(snapshot.size);
    });
    await Promise.resolve();
    await setDoc(doc(db, 'orders/o2'), { total: 20 });
    await Promise.resolve();

    expect(sizes).toEqual([1, 2]);
    expect(deliveryEvents(events)).toHaveLength(2);
    unsubscribe();
  });
});
