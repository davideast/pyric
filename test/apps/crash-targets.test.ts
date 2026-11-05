import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { CDPSession } from '@playwright/test';
import { WorkerTargetWatch, type TargetCrash } from './crash-targets.ts';

/** A browser CDP session that records what it is sent and emits what the test says. */
function fakeSession() {
  const events = new EventEmitter();
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let sessions = 0;
  const session = {
    on: (event: string, listener: (params: never) => void) => { events.on(event, listener); return session; },
    send: async (method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      if (method === 'Target.attachToTarget') return { sessionId: `session-${(sessions += 1)}` };
      return {};
    },
    detach: async () => {},
  };
  return { events, sent, session: session as unknown as CDPSession };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const target = (targetId: string, type: string, url: string, browserContextId = 'ours') => ({ targetInfo: { targetId, type, url, browserContextId } });

function exception(text: string, description: string, exceptionId = 1) {
  return JSON.stringify({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { exceptionId, text, exception: { description } } } });
}

describe('WorkerTargetWatch', () => {
  test("attaches to this context's shared and service workers and reads their exceptions", async () => {
    const fake = fakeSession();
    const crashes: TargetCrash[] = [];
    const watch = new WorkerTargetWatch(fake.session, (crash) => crashes.push(crash));
    await watch.start();
    expect(fake.sent[0]).toEqual({ method: 'Target.setDiscoverTargets', params: { discover: true } });

    // Seen before the context id is known: held until it is.
    fake.events.emit('Target.targetCreated', target('shared', 'shared_worker', 'http://127.0.0.1:5173/shared.js'));
    watch.setContextId('ours');
    fake.events.emit('Target.targetCreated', target('sw', 'service_worker', 'http://127.0.0.1:5173/sw.js'));
    fake.events.emit('Target.targetCreated', target('other-app', 'shared_worker', 'http://127.0.0.1:6000/shared.js', 'theirs'));
    fake.events.emit('Target.targetCreated', target('page', 'page', 'http://127.0.0.1:5173/'));
    await flush();

    const attached = fake.sent.filter((call) => call.method === 'Target.attachToTarget').map((call) => call.params);
    expect(attached).toEqual([{ targetId: 'shared', flatten: false }, { targetId: 'sw', flatten: false }]);
    const enabled = fake.sent.filter((call) => call.method === 'Target.sendMessageToTarget').map((call) => call.params);
    expect(enabled).toEqual([
      { sessionId: 'session-1', message: JSON.stringify({ id: 1, method: 'Runtime.enable' }) },
      { sessionId: 'session-2', message: JSON.stringify({ id: 1, method: 'Runtime.enable' }) },
    ]);

    const thrown = exception('Uncaught', 'Error: shared worker throw\n    at http://127.0.0.1:5173/shared.js:3:53');
    fake.events.emit('Target.receivedMessageFromTarget', { sessionId: 'session-1', message: thrown });
    // Runtime.enable replays an error the worker threw while its script ran; the same exception twice counts once.
    fake.events.emit('Target.receivedMessageFromTarget', { sessionId: 'session-1', message: thrown });
    fake.events.emit('Target.receivedMessageFromTarget', { sessionId: 'session-2', message: exception('Uncaught (in promise)', 'Error: early rejection', 4) });
    fake.events.emit('Target.receivedMessageFromTarget', { sessionId: 'session-2', message: JSON.stringify({ id: 1, result: {} }) });
    fake.events.emit('Target.receivedMessageFromTarget', { sessionId: 'unknown', message: thrown });

    expect(crashes).toEqual([
      { kind: 'shared worker uncaught exception', source: 'shared worker http://127.0.0.1:5173/shared.js', message: 'Error: shared worker throw', stack: ['    at http://127.0.0.1:5173/shared.js:3:53'] },
      { kind: 'service worker unhandled rejection', source: 'service worker http://127.0.0.1:5173/sw.js', message: 'Error: early rejection', stack: [] },
    ]);
  });

  test('resumes a shared worker that restarted while the watch was attached', async () => {
    const fake = fakeSession();
    const watch = new WorkerTargetWatch(fake.session, () => {});
    await watch.start();
    watch.setContextId('ours');
    fake.events.emit('Target.targetCreated', target('shared', 'shared_worker', 'http://x/shared.js'));
    await flush();
    // A reload ends the page's only client; Chromium restarts the worker under the
    // same target and session and holds it before its script runs.
    const restarted = JSON.stringify({ method: 'Inspector.targetReloadedAfterCrash', params: {} });
    fake.events.emit('Target.receivedMessageFromTarget', { sessionId: 'session-1', message: restarted });
    await flush();
    const toTarget = fake.sent.filter((call) => call.method === 'Target.sendMessageToTarget').map((call) => call.params);
    expect(toTarget).toEqual([
      { sessionId: 'session-1', message: JSON.stringify({ id: 1, method: 'Runtime.enable' }) },
      { sessionId: 'session-1', message: JSON.stringify({ id: 2, method: 'Runtime.runIfWaitingForDebugger' }) },
    ]);
  });

  test('a rejection with a non-Error reason reads its value', async () => {
    const fake = fakeSession();
    const crashes: TargetCrash[] = [];
    const watch = new WorkerTargetWatch(fake.session, (crash) => crashes.push(crash));
    await watch.start();
    watch.setContextId('ours');
    fake.events.emit('Target.targetCreated', target('shared', 'shared_worker', 'http://x/shared.js'));
    await flush();
    const message = JSON.stringify({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { exceptionId: 2, text: 'Uncaught (in promise)', exception: { value: 'nope' } } } });
    fake.events.emit('Target.receivedMessageFromTarget', { sessionId: 'session-1', message });
    expect(crashes.map((crash) => `${crash.kind}: ${crash.message}`)).toEqual(['shared worker unhandled rejection: Uncaught (in promise) "nope"']);
  });
});
