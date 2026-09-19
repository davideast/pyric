import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { isBridgeMessage, type BridgeMessage } from '../../../src/bridge/protocol.js';
import { startSoakServe, waitForPeer } from '../soak/harness.js';

const depthError = 'Firestore query nesting exceeds 64 layers.';
const shapeError = 'Invalid Firestore query structure.';
const collection = { __ref: 'collection', path: 'shared' };

function nestedSources(layers: number, constraints: unknown[] = []): unknown {
  return Array.from({ length: layers }).reduce<unknown>((source, _, index) => {
    const isInnermost = index === 0;
    return { __ref: 'query', source, constraints: isInnermost ? constraints : [] };
  }, collection);
}

function nestedFilters(layers: number, kind: 'and' | 'or'): unknown {
  return Array.from({ length: layers }).reduce<unknown>(
    filter => ({ kind, filters: [filter] }),
    { kind: 'where', field: 'message', op: '==', value: 'Hello from the other browser' },
  );
}

interface QueryCase { label: string; target: unknown; error?: string }
const cases: QueryCase[] = [{ label: 'plain collection', target: collection }];
for (const layers of [63, 64, 65, 256]) {
  const exceedsDepth = layers > 64;
  cases.push({ label: `${layers} query sources`, target: nestedSources(layers), error: exceedsDepth ? depthError : undefined });
}
for (const kind of ['and', 'or'] satisfies ('and' | 'or')[]) {
  for (const layers of [62, 63, 64, 256]) {
    const exceedsDepth = layers >= 64;
    cases.push({ label: `${layers} ${kind} filters`, target: nestedSources(1, [nestedFilters(layers, kind)]), error: exceedsDepth ? depthError : undefined });
  }
}
for (const layers of [32, 33]) {
  const exceedsDepth = layers === 33;
  cases.push({ label: `32 sources and ${layers} filters`, target: nestedSources(32, [nestedFilters(layers, 'and')]), error: exceedsDepth ? depthError : undefined });
}
for (const value of [null, 7, [], 'invalid']) {
  cases.push({ label: `source ${JSON.stringify(value)}`, target: { __ref: 'query', source: value, constraints: [] }, error: shapeError });
  const isInvalidArray = !Array.isArray(value);
  if (isInvalidArray) cases.push({ label: `constraints ${JSON.stringify(value)}`, target: { __ref: 'query', source: collection, constraints: value }, error: shapeError });
}
cases.push({ label: 'constraints object', target: { __ref: 'query', source: collection, constraints: {} }, error: shapeError });
cases.push({ label: 'missing source', target: { __ref: 'query', constraints: [] }, error: shapeError });
for (const filters of [null, {}, [null]]) {
  cases.push({ label: `malformed composite ${JSON.stringify(filters)}`, target: nestedSources(1, [{ kind: 'and', filters }]), error: shapeError });
}
cases.push({ label: 'empty composite', target: nestedSources(1, [{ kind: 'and', filters: [] }]), error: 'A composite filter requires at least one filter.' });
cases.push({ label: 'non-filter composite child', target: nestedSources(1, [{ kind: 'and', filters: [{ kind: 'orderBy', field: 'message' }] }]), error: 'A composite filter cannot contain a non-filter constraint.' });
cases.push({ label: 'null constraint', target: nestedSources(1, [null]), error: shapeError });
cases.push({ label: 'unknown constraint', target: nestedSources(1, [{ kind: 'unknown' }]), error: 'Unsupported Firestore query constraint descriptor.' });
cases.push({ label: 'malformed cursor values', target: nestedSources(1, [{ kind: 'startAt', values: {} }]), error: shapeError });
cases.push({ label: 'malformed collection path', target: { __ref: 'collection', path: null }, error: shapeError });
cases.push({ label: 'malformed group ID', target: { __ref: 'group', collectionId: 7 }, error: shapeError });

for (const mode of ['hosted', 'shared-worker']) {
  test(`${mode} validates query structure and preserves healthy listeners`, async ({ page }) => {
    const flags = ['--no-capture'];
    const usesHostedRuntime = mode === 'hosted';
    if (usesHostedRuntime) flags.push('--hosted');
    const fixture = await startSoakServe({
      flags,
      extraFiles: {
        'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
        'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
      },
    });
    const socket = new WebSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
    let attached = false;
    let pending: { id: string; resolve: (frame: BridgeMessage) => void } | undefined;
    const snapshots = new Map<string, BridgeMessage[]>();
    socket.on('message', data => {
      const frame: unknown = JSON.parse(data.toString());
      const isKnownFrame = isBridgeMessage(frame);
      if (isKnownFrame) {
        const isAcknowledgment = frame.type === 'attach-ack';
        if (isAcknowledgment) attached = true;
        let id: string | undefined;
        const isResponse = frame.type === 'worker-res';
        const isSnapshot = frame.type === 'worker-snap';
        if (isResponse) id = frame.id;
        if (isSnapshot) {
          id = frame.subId;
          const received = snapshots.get(id) ?? [];
          received.push(frame);
          snapshots.set(id, received);
        }
        const active = pending;
        const matchesRequest = active !== undefined && active.id === id;
        if (matchesRequest) active.resolve(frame);
      }
    });
    async function request(id: string, frame: unknown): Promise<BridgeMessage> {
      const reply = Promise.withResolvers<BridgeMessage>();
      pending = { id, resolve: reply.resolve };
      const deadline = setTimeout(() => reply.reject(new Error(`No query reply for ${id}`)), 3_000);
      try {
        socket.send(JSON.stringify(frame));
        return await reply.promise;
      } finally {
        clearTimeout(deadline);
        pending = undefined;
      }
    }
    const rejectedSubscriptions: string[] = [];
    try {
      await page.goto(fixture.info.url);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe(mode);
      await waitForPeer(fixture.info.url);
      await expect.poll(() => socket.readyState).toBe(WebSocket.OPEN);
      socket.send(JSON.stringify({ type: 'attach', protocol: 1 }));
      await expect.poll(() => attached).toBe(true);
      await request('healthy', { type: 'worker-sub', subId: 'healthy', sub: { target: collection, actAs: { mode: 'admin' } } });
      for (const [index, scenario] of cases.entries()) {
        await test.step(scenario.label, async () => {
          const { target, error } = scenario;
          const expectsRefusal = error !== undefined;
          for (const method of ['getDocs', 'count', 'aggregate'] satisfies ('getDocs' | 'count' | 'aggregate')[]) {
            const id = `${index}-${method}`;
            const result = await request(id, {
              type: 'worker-op', id,
              op: { method, source: target, spec: { count: { kind: 'count' } }, actAs: { mode: 'admin' } },
            });
            if (expectsRefusal) expect(result).toMatchObject({ ok: false, error: { code: 'invalid-argument', message: error } });
            else {
              const expected = {
                getDocs: { docs: [{ path: 'shared/greeting' }] },
                count: { count: 1 }, aggregate: { data: { count: 1 } },
              };
              expect(result, JSON.stringify(result)).toMatchObject({ ok: true, value: expected[method] });
            }
          }
          const id = `subscription-${index}`;
          const result = await request(id, { type: 'worker-sub', subId: id, sub: { target, actAs: { mode: 'admin' } } });
          if (expectsRefusal) {
            expect(result).toMatchObject({ value: { __error: { code: 'invalid-argument', message: error } } });
            rejectedSubscriptions.push(id);
          } else {
            expect(result).toMatchObject({ value: { docs: [{ path: 'shared/greeting' }] } });
            socket.send(JSON.stringify({ type: 'worker-unsub', subId: id }));
          }
        });
      }
      await expect(request('write', {
        type: 'worker-op', id: 'write', op: { method: 'setDoc', path: 'shared/greeting',
          data: { message: 'Requesting client still works' }, actAs: { mode: 'admin' } },
      })).resolves.toMatchObject({ ok: true });
      await expect(page.locator('#document')).toHaveText('Requesting client still works');
      await page.evaluate(async () => {
        const sdk = await import('firebase/firestore');
        await sdk.setDoc(sdk.doc(sdk.getFirestore(), 'shared/greeting'), { message: 'Independent client still works' });
      });
      await expect(page.locator('#document')).toHaveText('Independent client still works');
      await expect.poll(() => JSON.stringify(snapshots.get('healthy'))).toContain('Independent client still works');
      for (const id of rejectedSubscriptions) expect(snapshots.get(id)).toHaveLength(1);
      await expect(request('read', { type: 'worker-op', id: 'read', op: { method: 'getDocs', source: collection, actAs: { mode: 'admin' } } }))
        .resolves.toMatchObject({ ok: true, value: { docs: [{ path: 'shared/greeting' }] } });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.close();
      await page.close();
      await fixture.stop();
    }
  });
}
