import { describe, expect, it } from 'bun:test';
import { activeListeners, initializeSandbox, type SandboxEvent } from '../../src/sandbox/index.js';
import { primeEventHistory } from '../../src/sandbox/internal/index.js';
import { primedHistoryEvents } from '../../src/sandbox/internal/primed-history.js';

describe('primedHistoryEvents and primeEventHistory', () => {
  it('closes un-detached observed live and admin listeners on host restart while leaving sandbox listeners intact', () => {
    const events = [
      {
        kind: 'listener',
        id: 'la-live-open',
        at: 1_000,
        service: 'rtdb',
        phase: 'attach',
        listenerId: 'page:tab-1:l-1',
        target: { kind: 'ref', path: 'rooms/r1' },
        auth: { uid: 'u-1' },
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      },
      {
        kind: 'listener',
        id: 'la-admin-open',
        at: 1_100,
        service: 'firestore',
        phase: 'attach',
        listenerId: 'admin:l-2',
        target: { kind: 'query', path: 'items' },
        auth: null,
        rulesDisposition: { kind: 'bypassed', reason: 'admin' },
      },
      {
        kind: 'listener',
        id: 'la-live-closed',
        at: 1_200,
        service: 'firestore',
        phase: 'attach',
        listenerId: 'page:tab-1:l-3',
        target: { kind: 'doc', path: 'items/i1' },
        auth: { uid: 'u-1' },
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      },
      {
        kind: 'listener',
        id: 'ld-live-closed',
        at: 1_300,
        service: 'firestore',
        phase: 'detach',
        listenerId: 'page:tab-1:l-3',
        target: { kind: 'doc', path: 'items/i1' },
        auth: { uid: 'u-1' },
        rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      },
      {
        kind: 'listener',
        id: 'la-sandbox',
        at: 1_400,
        service: 'firestore',
        phase: 'attach',
        listenerId: 'sbx-1',
        target: { collection: 'rooms' },
        auth: { uid: 'u-1' },
        rulesDisposition: { kind: 'evaluated', verdict: 'allow' },
      },
    ] as unknown as SandboxEvent[];

    const primed = primedHistoryEvents(events);
    expect(primed).toHaveLength(7);
    const syntheticDetaches = primed.slice(5);
    expect(syntheticDetaches).toMatchObject([
      {
        kind: 'listener',
        id: 'la-live-open:host-restarted',
        at: 1_400,
        phase: 'detach',
        listenerId: 'page:tab-1:l-1',
      },
      {
        kind: 'listener',
        id: 'la-admin-open:host-restarted',
        at: 1_400,
        phase: 'detach',
        listenerId: 'admin:l-2',
      },
    ]);

    // A second host restart over an already-primed capture never emits duplicate detaches:
    const reprimed = primedHistoryEvents(primed);
    expect(reprimed).toHaveLength(7);
    expect(reprimed).toEqual(primed);

    const sandbox = initializeSandbox({ projectId: 'demo-app' });
    expect(primeEventHistory(sandbox, events)).toBe(events.length);
    const active = activeListeners(sandbox.history());
    expect(active.map((entry) => entry.id)).toEqual(['sbx-1']);
    sandbox.dispose();
  });
});
