import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'bun:test';
import { healthLiveStatus } from '../../../src/serve/runtime/chip-live-status.js';
import type { HostRestart } from '../../../src/serve/runtime/host-restart.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A page served by `boot-1` whose host's health report names `reportedBoot`. */
function pageServedBy(reportedBoot: () => string): Document {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  cleanups.push(() => dom.window.close());
  const view = dom.window as unknown as Window & { __PYRIC_HOST_INSTANCE_ID__?: string };
  view.__PYRIC_HOST_INSTANCE_ID__ = 'boot-1';
  view.fetch = (async () => Response.json({
    status: 'ok',
    instanceId: reportedBoot(),
    live: {
      projectId: 'my-project',
      configProjectId: 'my-project',
      configSource: '.firebaserc',
      appProjectIds: ['my-project'],
      billed: { reads: 0, writes: 0, deliveries: 0 },
    },
  })) as typeof fetch;
  return dom.window.document;
}

describe('the health report read', () => {
  it('reports a host that restarted since the page loaded, once', async () => {
    const restarts: HostRestart[] = [];
    const read = healthLiveStatus(pageServedBy(() => 'boot-2'), restart => restarts.push(restart));
    expect((await read())?.projectId).toBe('my-project');
    await read();
    expect(restarts).toEqual([{ initialHostInstanceId: 'boot-1', currentHostInstanceId: 'boot-2' }]);
  });

  it('reports nothing while the host that served the page still answers', async () => {
    const restarts: HostRestart[] = [];
    const read = healthLiveStatus(pageServedBy(() => 'boot-1'), restart => restarts.push(restart));
    await read();
    expect(restarts).toEqual([]);
  });

  it('returns null instead of throwing on 401 or 403 so refused remote pages do not retry', async () => {
    for (const status of [401, 403]) {
      let calls = 0;
      const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://10.203.0.1/' });
      cleanups.push(() => dom.window.close());
      dom.window.fetch = (async () => {
        calls += 1;
        return new Response('refused', { status });
      }) as typeof fetch;
      const read = healthLiveStatus(dom.window.document);
      expect(await read()).toBeNull();
      expect(calls).toBe(1);
    }
  });
});
