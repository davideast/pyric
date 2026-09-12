/**
 * Component-owner attribution wired through `useFirestoreDoc`.
 *
 * `useFirestoreDoc` calls `useListenerOwner()` (see
 * `src/primitives/hooks/useListenerOwner.ts`) and threads the result into
 * `onSnapshot`'s `owner` option, so a consumer using the hook is attributed
 * with no extra code. These tests render a small component tree
 * (`App > Dashboard > OrdersTable`) and read the sandbox's own
 * `listener_attach` event, rather than inspecting the hook directly, so they
 * prove the wiring end to end.
 *
 * These tests share the "second `initializeSandbox()` cycle in one Bun
 * process" hazard `useFirestoreDoc.test.tsx` documents (no `setRules` or
 * `setDoc` call in a single sandbox), so each `it` uses its own sandbox and
 * none call `setDoc`.
 */
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'bun:test';
import { doc, getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import type { SandboxEvent } from 'pyric/sandbox';
import { seedDocuments } from 'pyric/sandbox/firestore';
import { useFirestoreDoc } from '../../../src/firestore/hooks/useFirestoreDoc.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setupSandbox() {
  const sandbox = initializeSandbox();
  seedDocuments(sandbox, { 'orders/o1': { total: 10 } });
  const events: SandboxEvent[] = [];
  sandbox.onEvent((event) => events.push(event));
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  return { db, events };
}

function attachEvents(events: SandboxEvent[]) {
  return events.filter((event) => event.kind === 'listener_attach');
}

describe('component owner attribution through useFirestoreDoc', () => {
  it('attributes the attach event to the component that called the hook', async () => {
    const { db, events } = setupSandbox();
    const ref = doc(db, 'orders/o1');

    function OrdersTable() {
      useFirestoreDoc(ref);
      return null;
    }
    function Dashboard() {
      return createElement(OrdersTable);
    }
    function App() {
      return createElement(Dashboard);
    }

    await act(async () => {
      create(createElement(App));
    });

    const owners = attachEvents(events)[0]?.owners ?? [];
    const component = owners.find((owner) => owner.kind === 'component');
    expect(component).toBeDefined();
    if (component?.kind !== 'component') throw new Error('expected a component owner');
    expect(component.name).toBe('OrdersTable');
  });

  it('records no component owner in a production build', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { db, events } = setupSandbox();
      const ref = doc(db, 'orders/o1');

      function OrdersTable() {
        useFirestoreDoc(ref);
        return null;
      }

      await act(async () => {
        create(createElement(OrdersTable));
      });

      const owners = attachEvents(events)[0]?.owners;
      expect(owners?.some((owner) => owner.kind === 'component')).toBeFalsy();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
