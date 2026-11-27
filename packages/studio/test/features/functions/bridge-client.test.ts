import { describe, expect, it } from 'bun:test';
import {
  createFunctionsBridgeApi,
  type DiscoveredTrigger,
} from '../../../src/features/functions/index.js';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createMockFetch(
  handler: (req: RecordedRequest) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    }
    const recorded: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(recorded);
    return handler(recorded);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('createFunctionsBridgeApi', () => {
  it('calls functions.listTriggers and functions.executions via POST /__pyric/hosted/method', async () => {
    const { fetchImpl, calls } = createMockFetch((req) => {
      const payload = JSON.parse(req.body ?? '{}') as { key: string };
      if (payload.key === 'functions.listTriggers') {
        return jsonResponse({
          ok: true,
          summary: '1 trigger(s), 1 unsupported',
          data: {
            triggers: [
              {
                exportName: 'makeUppercase',
                eventType: 'google.firebase.database.ref.v1.created',
                reference: 'messages/{pushId}/original',
                instance: '*',
              },
            ],
            unsupported: [
              { exportName: 'legacyCron', eventType: 'schedule (v1 pubsub.schedule is not supported)' },
            ],
          },
        });
      }
      return jsonResponse({
        ok: true,
        summary: '1 execution(s)',
        data: {
          executions: [
            {
              id: '1',
              trigger: 'makeUppercase',
              cause: { ref: '/messages/m1/original', params: { pushId: 'm1' } },
              startedAt: 1700000000000,
              durationMs: 18,
              status: 'fulfilled',
              result: { ok: true },
            },
          ],
        },
      });
    });

    const api = createFunctionsBridgeApi({
      baseUrl: 'http://localhost:3473',
      instanceId: 'inst-1',
      projectDir: '/workspace/demo',
      projectId: 'demo-app',
      sessionToken: 'tok-secret',
      fetchImpl,
    });

    const listRes = await api.listTriggers();
    expect(listRes.ok).toBe(true);
    if (listRes.ok) {
      expect(listRes.data.triggers).toHaveLength(1);
      expect(listRes.data.unsupported).toHaveLength(1);
    }

    const execRes = await api.listExecutions(1699999999000);
    expect(execRes.ok).toBe(true);
    if (execRes.ok) {
      expect(execRes.data).toHaveLength(1);
      expect(execRes.data[0]!.trigger).toBe('makeUppercase');
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('http://localhost:3473/__pyric/hosted/method');
    expect(calls[0]!.headers['x-pyric-session-token']).toBe('tok-secret');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      instanceId: 'inst-1',
      projectDir: '/workspace/demo',
      key: 'functions.listTriggers',
      args: {},
      allowProduction: false,
    });
    expect(JSON.parse(calls[1]!.body!).args).toEqual({ since: 1699999999000 });
  });

  it('returns shared-worker-fallback on 404 and stale-instance on 409', async () => {
    const missing = createMockFetch(() => new Response('', { status: 404 }));
    const api404 = createFunctionsBridgeApi({
      baseUrl: 'http://localhost:3473',
      instanceId: 'inst-1',
      projectDir: '/workspace/demo',
      fetchImpl: missing.fetchImpl,
    });
    const res404 = await api404.listTriggers();
    expect(res404.ok).toBe(false);
    if (!res404.ok) {
      expect(res404.failure.kind).toBe('shared-worker-fallback');
      expect(res404.failure.message).toContain('pyric sandbox --hosted');
    }

    const conflict = createMockFetch(() => jsonResponse({ ok: false, summary: 'changed' }, 409));
    const api409 = createFunctionsBridgeApi({
      baseUrl: 'http://localhost:3473',
      instanceId: 'inst-1',
      projectDir: '/workspace/demo',
      fetchImpl: conflict.fetchImpl,
    });
    const res409 = await api409.listTriggers();
    expect(res409.ok).toBe(false);
    if (!res409.ok) expect(res409.failure.kind).toBe('stale-instance');
  });

  it('resolves missing instanceId via /__pyric/health and degrades when unavailable', async () => {
    const { fetchImpl, calls } = createMockFetch((req) => {
      if (req.url.endsWith('/__pyric/health')) {
        return jsonResponse({ status: 'ok', instanceId: 'resolved-inst', sandboxConnected: true });
      }
      return jsonResponse({ ok: true, summary: '0 trigger(s)', data: { triggers: [], unsupported: [] } });
    });

    const api = createFunctionsBridgeApi({
      baseUrl: 'http://localhost:3473',
      instanceId: null,
      projectDir: '/workspace/demo',
      fetchImpl,
    });
    const res = await api.listTriggers();
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toBe('http://localhost:3473/__pyric/health');
    expect(JSON.parse(calls[1]!.body!).instanceId).toBe('resolved-inst');

    const apiNoDir = createFunctionsBridgeApi({
      baseUrl: 'http://localhost:3473',
      instanceId: 'inst-1',
      projectDir: null,
      fetchImpl,
    });
    const noDirRes = await apiNoDir.listTriggers();
    expect(noDirRes.ok).toBe(false);
    if (!noDirRes.ok) expect(noDirRes.failure.kind).toBe('shared-worker-fallback');
  });

  it('fires RTDB, HTTP, Callable, Scheduler, Pub/Sub, and Tasks triggers cleanly', async () => {
    const { fetchImpl, calls } = createMockFetch((req) => {
      if (req.url.includes('/__pyric/hosted/method')) {
        const body = JSON.parse(req.body ?? '{}') as { key: string; args: Record<string, unknown> };
        return jsonResponse({
          ok: true,
          summary: `Ran ${body.key}`,
          data: { executionId: '7', result: { echoed: body.args } },
        });
      }
      if (req.url.includes('/demo-app/us-central1/greet')) {
        return jsonResponse({ hello: 'studio' }, 200);
      }
      if (req.url.includes('/demo-app/us-east1/score')) {
        return jsonResponse({ result: { points: 42 } }, 200);
      }
      return new Response('not found', { status: 404 });
    });

    const api = createFunctionsBridgeApi({
      baseUrl: 'http://localhost:3473',
      instanceId: 'inst-1',
      projectDir: '/workspace/demo',
      projectId: 'demo-app',
      fetchImpl,
    });

    const rtdbTrigger: DiscoveredTrigger = {
      exportName: 'makeUppercase',
      eventType: 'google.firebase.database.ref.v1.created',
      reference: 'messages/{id}/original',
    };
    const rtdbRes = await api.fireTrigger(rtdbTrigger, {
      path: 'messages/m1/original',
      payload: 'hello',
      timeoutMs: 5000,
    });
    expect(rtdbRes.ok).toBe(true);
    expect(rtdbRes.executionId).toBe('7');

    const httpRes = await api.fireTrigger(
      { exportName: 'greet', eventType: 'https', regions: ['us-central1'] },
      { httpMethod: 'POST', path: '/status', payload: { ping: true }, region: 'us-central1' },
    );
    expect(httpRes.ok).toBe(true);
    expect(httpRes.statusCode).toBe(200);
    expect(httpRes.result).toEqual({ hello: 'studio' });

    const callableRes = await api.fireTrigger(
      { exportName: 'score', eventType: 'callable', regions: ['us-east1'] },
      { payload: { user: 'u1' }, region: 'us-east1' },
    );
    expect(callableRes.ok).toBe(true);
    expect(callableRes.result).toEqual({ points: 42 });

    const schedRes = await api.fireTrigger(
      { exportName: 'nightly', eventType: 'schedule', schedule: 'every 24 hours' },
      { payload: { jobName: 'manual' } },
    );
    expect(schedRes.ok).toBe(true);

    const pubsubRes = await api.fireTrigger(
      {
        exportName: 'onTopic',
        eventType: 'google.cloud.pubsub.topic.v1.messagePublished',
        topic: 'orders',
      },
      { payload: { orderId: 'o1' }, attributes: { source: 'studio' } },
    );
    expect(pubsubRes.ok).toBe(true);

    const tasksRes = await api.fireTrigger(
      { exportName: 'emailQueue', eventType: 'task-queue', regions: ['us-central1'] },
      { payload: { to: 'a@example.com' } },
    );
    expect(tasksRes.ok).toBe(true);

    const autoRes = await api.fireTrigger(
      {
        exportName: 'onDoc',
        eventType: 'google.cloud.firestore.document.v1.created',
        document: 'items/{id}',
      },
      {},
    );
    expect(autoRes.ok).toBe(false);
    expect(calls).toHaveLength(6);

    // Ensure Scheduler and Tasks payloads do not include duplicate alias keys.
    const schedPayload = JSON.parse(calls[3]!.body!) as { args: Record<string, unknown> };
    expect(schedPayload.args).toEqual({ jobName: 'manual', trigger: 'nightly' });
    expect('exportName' in schedPayload.args).toBe(false);

    const tasksPayload = JSON.parse(calls[5]!.body!) as { args: Record<string, unknown> };
    expect(tasksPayload.args).toEqual({ trigger: 'emailQueue', data: { to: 'a@example.com' } });
    expect('targetName' in tasksPayload.args).toBe(false);
  });

  it('hydrates projectId from /__pyric/health on non-RTDB projects for URLs and gateway Fire', async () => {
    const { fetchImpl, calls } = createMockFetch((req) => {
      if (req.url.endsWith('/__pyric/health')) {
        return jsonResponse({
          status: 'ok',
          mode: 'sandbox',
          project: 'my-real-app',
          instanceId: 'inst-real',
          sandboxConnected: true,
        });
      }
      if (req.url.endsWith('/__pyric/hosted/method')) {
        return jsonResponse({
          ok: true,
          summary: '1 trigger(s)',
          data: {
            triggers: [{ exportName: 'greet', eventType: 'https', regions: ['us-central1'] }],
            unsupported: [],
          },
        });
      }
      if (req.url === 'http://localhost:3473/my-real-app/us-central1/greet') {
        return jsonResponse({ ok: true, project: 'my-real-app' }, 200);
      }
      return new Response('not found', { status: 404 });
    });

    const api = createFunctionsBridgeApi({
      baseUrl: 'http://localhost:3473',
      instanceId: 'inst-real',
      projectDir: '/workspace/non-rtdb',
      projectId: null,
      fetchImpl,
    });

    const listRes = await api.listTriggers();
    expect(listRes.ok).toBe(true);
    if (listRes.ok) {
      expect(listRes.data.projectId).toBe('my-real-app');
    }
    expect(api.projectId).toBe('my-real-app');

    const fireRes = await api.fireTrigger(
      { exportName: 'greet', eventType: 'https', regions: ['us-central1'] },
      { httpMethod: 'POST', payload: { hi: true }, region: 'us-central1' },
    );
    expect(fireRes.ok).toBe(true);
    expect(fireRes.result).toEqual({ ok: true, project: 'my-real-app' });
    expect(calls.filter((c) => c.url.endsWith('/__pyric/health'))).toHaveLength(1);

    // Also hydrates on direct HTTP fire even before listTriggers() is called.
    const directApi = createFunctionsBridgeApi({
      baseUrl: 'http://localhost:3473',
      instanceId: 'inst-real',
      projectDir: '/workspace/non-rtdb',
      projectId: null,
      fetchImpl,
    });
    const directFire = await directApi.fireTrigger(
      { exportName: 'greet', eventType: 'https', regions: ['us-central1'] },
      { httpMethod: 'GET', region: 'us-central1' },
    );
    expect(directFire.ok).toBe(true);
    expect(directApi.projectId).toBe('my-real-app');
  });

  it('sanitizes unknown surface method errors when firing Scheduler, Pub/Sub, or Tasks on older hosts', async () => {
    const { fetchImpl } = createMockFetch((req) => {
      const payload = JSON.parse(req.body ?? '{}') as { key: string };
      return jsonResponse(
        { ok: false, summary: `unknown surface method '${payload.key}'` },
        400,
      );
    });

    const api = createFunctionsBridgeApi({
      baseUrl: 'http://localhost:3473',
      instanceId: 'inst-1',
      projectDir: '/workspace/demo',
      projectId: 'demo-app',
      fetchImpl,
    });

    const schedRes = await api.fireTrigger(
      { exportName: 'nightly', eventType: 'schedule', schedule: 'every 24 hours' },
      {},
    );
    expect(schedRes.ok).toBe(false);
    expect(schedRes.summary).toContain('Scheduler');
    expect(schedRes.summary).toContain('nightly');
    expect(schedRes.summary).not.toContain('unknown surface method');
    expect(schedRes.summary).not.toContain('functions.triggerScheduled');

    const pubsubRes = await api.fireTrigger(
      {
        exportName: 'onOrder',
        eventType: 'google.cloud.pubsub.topic.v1.messagePublished',
        topic: 'orders',
      },
      {},
    );
    expect(pubsubRes.ok).toBe(false);
    expect(pubsubRes.summary).toContain('Pub/Sub');
    expect(pubsubRes.summary).not.toContain('functions.publishPubSub');

    const taskRes = await api.fireTrigger(
      { exportName: 'sendMail', eventType: 'task-queue', regions: ['us-central1'] },
      {},
    );
    expect(taskRes.ok).toBe(false);
    expect(taskRes.summary).toContain('Tasks');
    expect(taskRes.summary).not.toContain('functions.enqueueTask');
  });
});
