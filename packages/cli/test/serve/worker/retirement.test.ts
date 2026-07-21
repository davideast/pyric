import { describe, expect, it } from 'bun:test';
import { createWorkerRetirement } from '../../../src/serve/worker/retirement.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

describe('SharedWorker retirement', () => {
  it('drains accepted work, acknowledges the requester, notifies every page, then closes', async () => {
    const firstMessages: unknown[] = [];
    const secondMessages: unknown[] = [];
    const first = { postMessage: (message: unknown) => firstMessages.push(message) };
    const second = { postMessage: (message: unknown) => secondMessages.push(message) };
    const work = deferred();
    const scheduled: Array<() => void> = [];
    let closed = false;
    const retirement = createWorkerRetirement({
      closeWorker: () => { closed = true; },
      schedule: (run) => { scheduled.push(run); },
    });
    retirement.connect(first);
    retirement.connect(second);
    retirement.track(first, work.promise);

    const retiring = retirement.retire(first, 'replace-1', '0123456789abcdef');
    const alsoRetiring = retirement.retire(second, 'replace-2', '0123456789abcdef');
    await Promise.resolve();
    expect(firstMessages).toEqual([]);
    expect(retirement.accepting()).toBe(false);

    work.resolve();
    await Promise.all([retiring, alsoRetiring]);

    expect(firstMessages).toEqual([
      { t: 'res', id: 'replace-1', ok: true, value: { retiring: true } },
      { t: 'runtime-reload', epoch: '0123456789abcdef' },
    ]);
    expect(secondMessages).toEqual([
      { t: 'res', id: 'replace-2', ok: true, value: { retiring: true } },
      { t: 'runtime-reload', epoch: '0123456789abcdef' },
    ]);
    expect(closed).toBe(false);
    scheduled[0]?.();
    expect(closed).toBe(true);
  });

  it('still drains accepted work after its page disconnects', async () => {
    const disconnected = { postMessage() {} };
    const requesterMessages: unknown[] = [];
    const requester = { postMessage: (message: unknown) => requesterMessages.push(message) };
    const work = deferred();
    let closed = false;
    const retirement = createWorkerRetirement({
      closeWorker: () => { closed = true; },
      schedule: (run) => { run(); },
    });
    retirement.connect(disconnected);
    retirement.connect(requester);
    retirement.track(disconnected, work.promise);
    retirement.disconnect(disconnected);

    const retiring = retirement.retire(
      requester, 'replace-after-disconnect', '0123456789abcdef',
    );
    await Promise.resolve();
    expect(requesterMessages).toEqual([]);
    expect(closed).toBe(false);

    work.resolve();
    await retiring;
    expect(closed).toBe(true);
  });

  it('drains accepted ServiceWorker relay work outside direct page ports', async () => {
    const requesterMessages: unknown[] = [];
    const requester = { postMessage: (message: unknown) => requesterMessages.push(message) };
    const relayWork = deferred();
    let closed = false;
    const retirement = createWorkerRetirement({
      closeWorker: () => { closed = true; },
      schedule: (run) => { run(); },
    });
    retirement.connect(requester);
    retirement.trackDetached(relayWork.promise);

    const retiring = retirement.retire(
      requester, 'replace-with-relay', '0123456789abcdef',
    );
    await Promise.resolve();
    expect(requesterMessages).toEqual([]);
    expect(closed).toBe(false);

    relayWork.resolve();
    await retiring;
    expect(closed).toBe(true);
  });

  it('flushes capture before notifying pages and immediately redirects a late connection', async () => {
    const order: string[] = [];
    const scheduled: Array<() => void> = [];
    const requester = { postMessage: (message: unknown) => {
      const typed = message as { t?: string };
      order.push(typed.t === 'runtime-reload' ? 'reload' : 'ack');
    } };
    const retirement = createWorkerRetirement({
      beforeAnnounce: async () => { order.push('capture'); },
      closeWorker: () => { order.push('close'); },
      schedule: (run) => { scheduled.push(run); },
    });
    retirement.connect(requester);

    await retirement.retire(requester, 'replace-capture', '0123456789abcdef');
    expect(order).toEqual(['capture', 'ack', 'reload']);

    const lateMessages: unknown[] = [];
    retirement.connect({ postMessage: (message) => lateMessages.push(message) });
    expect(lateMessages).toEqual([
      { t: 'runtime-reload', epoch: '0123456789abcdef' },
    ]);
    scheduled[0]?.();
    expect(order).toEqual(['capture', 'ack', 'reload', 'close']);
  });

  it('rolls back retirement and reports an error when accepted work never drains', async () => {
    const messages: unknown[] = [];
    const requester = { postMessage: (message: unknown) => messages.push(message) };
    const work = deferred();
    let closes = 0;
    const retirement = createWorkerRetirement({
      closeWorker() { closes += 1; },
      drainTimeoutMs: 5,
    });
    retirement.connect(requester);
    retirement.track(requester, work.promise);

    await retirement.retire(requester, 'replace-timeout', '0123456789abcdef');

    expect(retirement.accepting()).toBe(true);
    expect(messages).toContainEqual({
      t: 'res', id: 'replace-timeout', ok: false,
      error: {
        code: 'pyric/worker-retirement-timeout',
        message: 'Worker retirement drain timed out after 5ms.',
      },
    });

    messages.length = 0;
    work.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(messages).toEqual([]);
    expect(closes).toBe(0);
  });
});
