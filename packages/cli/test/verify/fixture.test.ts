import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { emitSandboxEvent, observedCallEvent } from 'pyric/sandbox/internal';
import { buildVerifyFixture } from '../../src/verify/fixture.js';

describe('buildVerifyFixture live delivery key boundary', () => {
  it('strips sessionData-derived delivery paths and removedPaths before persisting capture fixtures', () => {
    const sandbox = initializeSandbox();
    const callEvent = observedCallEvent({
      service: 'firestore',
      method: 'onSnapshot',
      path: 'users',
      at: 1_700_000_000_000,
      outcome: { status: 'ok' },
      billedDocuments: 2,
      listenerId: 'l-1',
    });
    emitSandboxEvent(
      sandbox,
      {
        ...callEvent,
        detail: {
          ...callEvent.detail,
          listenerId: 'page:tab-1:l-1',
          delivery: {
            mode: 'delta',
            size: 2,
            paths: ['users/uid-alpha', 'users/uid-beta'],
            removedPaths: ['users/uid-gamma'],
          },
        },
      },
      { actor: { kind: 'app' }, authLens: { mode: 'app-session' } },
    );

    const fixture = buildVerifyFixture({ sandbox });
    const serialized = JSON.stringify(fixture);
    expect(serialized).not.toContain('uid-alpha');
    expect(serialized).not.toContain('uid-beta');
    expect(serialized).not.toContain('uid-gamma');

    const op = fixture.events.find((event) => event.kind === 'operation');
    expect(op && 'detail' in op ? op.detail : undefined).toEqual({
      listenerId: 'page:tab-1:l-1',
      delivery: {
        mode: 'delta',
        size: 2,
        paths: [],
      },
    });
  });
});
