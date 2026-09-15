import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { WebSocket as WireSocket } from 'ws';
import { expect, test } from '@playwright/test';
import { startServer } from '@pyric/cli/bridge';
import { connectBridge } from '@pyric/cli/bridge/client';
import { initializeSandbox } from 'pyric/sandbox';
import { doc, getDoc, getAdminFirestore } from 'pyric/firestore';
import { isBridgeMessage, type BridgeMessage } from '../../../src/bridge/protocol.js';
import { McpHttpClient, startSoakServe, waitForPeer } from '../soak/harness.js';

type ToolResult = Extract<BridgeMessage, { type: 'tool-result' }>;
const malformedOutcomes = ['outer-status', 'missing-result', 'result-status', 'result-summary', 'error-code', 'error-message'];

function malformedResult(frame: ToolResult, fault: string): unknown {
  switch (fault) {
    case 'outer-status': return { ...frame, ok: 'yes' };
    case 'missing-result': return { ...frame, ok: true, result: undefined };
    case 'result-status': return { ...frame, ok: true, result: { ok: 'yes', summary: 'Invalid status' } };
    case 'result-summary': return { ...frame, ok: true, result: { ok: true, summary: null } };
    case 'error-code': return { ...frame, ok: false, error: { code: 4, message: 'Invalid code' } };
    case 'error-message': return { ...frame, ok: false, error: { code: 'unknown', message: { detail: 'Invalid message' } } };
    case 'missing-id': return { ...frame, id: undefined };
    case 'nonstring-id': return { ...frame, id: 7 };
    default: throw new Error('Unknown fixture fault.');
  }
}

test('mounted bridge refuses malformed peer tool outcomes and keeps both callers usable', async ({ page }) => {
  let fault: string | undefined;
  let malformedReplies = 0;
  await page.routeWebSocket('**/__pyric/sandbox', route => {
    const server = route.connectToServer();
    route.onMessage(raw => {
      const frame: unknown = JSON.parse(raw.toString());
      const isToolResult = isBridgeMessage(frame) && frame.type === 'tool-result';
      const activeFault = fault;
      const changesReply = isToolResult && activeFault !== undefined;
      if (changesReply) {
        fault = undefined;
        malformedReplies += 1;
        server.send(JSON.stringify(malformedResult(frame, activeFault)));
        return;
      }
      server.send(raw);
    });
  });
  const fixture = await startSoakServe({ flags: ['--no-capture'], extraFiles: {
    'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
    'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
  } });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await waitForPeer(fixture.info.url);
    const busy = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
    const healthy = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
    await busy.initialize();
    await healthy.initialize();
    for (const scenario of malformedOutcomes) {
      fault = scenario;
      let outcome: unknown;
      const call = busy.toolCall('firestore_get_document', { path: 'shared/greeting', as: 'admin' })
        .then(value => { outcome = value; });
      await expect.poll(() => outcome, { timeout: 3_000 }).toMatchObject({ ok: false, summary: expect.any(String) });
      await call;
      await expect(healthy.toolCall('firestore_create_document', {
        path: `shared/${scenario}`, data: { scenario }, as: 'admin',
      })).resolves.toMatchObject({ ok: true });
      await expect(busy.toolCall('firestore_get_document', { path: `shared/${scenario}`, as: 'admin' }))
        .resolves.toMatchObject({ ok: true, data: { exists: true } });
    }
    expect(malformedReplies).toBe(malformedOutcomes.length);
    await page.locator('#write').click();
    await expect(page.locator('#write-result')).toHaveText('Written');
  } finally {
    await page.close().finally(() => fixture.stop());
  }
});

test('standalone bridge refuses malformed real peer tool outcomes before resolving calls', async () => {
  const NativeWebSocket = globalThis.WebSocket;
  let fault: string | undefined;
  globalThis.WebSocket = class extends NativeWebSocket {
    override send(data: Parameters<WebSocket['send']>[0]): void {
      const isText = typeof data === 'string';
      if (isText) {
        const frame: unknown = JSON.parse(data);
        const isToolResult = isBridgeMessage(frame) && frame.type === 'tool-result';
        const activeFault = fault;
        const changesReply = isToolResult && activeFault !== undefined;
        if (changesReply) {
          fault = undefined;
          super.send(JSON.stringify(malformedResult(frame, activeFault)));
          return;
        }
      }
      super.send(data);
    }
  };
  const server = await startServer({ port: 0, silent: true, disableAuditLog: true });
  const sandbox = initializeSandbox();
  let connected = false;
  const peer = connectBridge(sandbox, { url: `${server.url.replace('http:', 'ws:')}/sandbox`,
    onStateChange: state => { connected = state.kind === 'connected'; } });
  try {
    await expect.poll(() => connected).toBe(true);
    for (const scenario of malformedOutcomes) {
      fault = scenario;
      let outcome: unknown;
      const call = server.bridge.dispatch('firestore_get_document', { path: 'shared/greeting', as: 'admin' })
        .then(value => { outcome = value; });
      await expect.poll(() => outcome, { timeout: 3_000 }).toMatchObject({ ok: false, summary: expect.any(String) });
      await call;
      await expect(server.bridge.dispatch('firestore_create_document', {
        path: `shared/${scenario}`, data: { scenario }, as: 'admin',
      })).resolves.toMatchObject({ ok: true });
      expect((await getDoc(doc(getAdminFirestore(sandbox), `shared/${scenario}`))).data()).toEqual({ scenario });
    }
  } finally {
    peer.disconnect();
    sandbox.dispose();
    await server.stop();
    globalThis.WebSocket = NativeWebSocket;
  }
});

test('a replaced standalone peer cannot settle the current peer request', async () => {
  const server = await startServer({ port: 0, silent: true, disableAuditLog: true });
  const oldPeer = new WireSocket(`${server.url.replace('http:', 'ws:')}/sandbox`);
  const currentPeer = new WireSocket(`${server.url.replace('http:', 'ws:')}/sandbox`);
  const currentRequests: Extract<BridgeMessage, { type: 'tool-call' }>[] = [];
  currentPeer.on('message', raw => {
    const frame: unknown = JSON.parse(raw.toString());
    const isToolCall = isBridgeMessage(frame) && frame.type === 'tool-call';
    if (isToolCall) currentRequests.push(frame);
  });
  try {
    await Promise.all([once(oldPeer, 'open'), once(currentPeer, 'open')]);
    oldPeer.send(JSON.stringify({ type: 'hello', protocol: 1, sandboxId: 'old', tools: ['firestore_get_document'] }));
    await expect.poll(() => server.bridge.isSandboxConnected()).toBe(true);
    currentPeer.send(JSON.stringify({ type: 'hello', protocol: 1, sandboxId: 'current', tools: ['firestore_get_document'] }));
    await expect.poll(() => server.bridge.peerGeneration()).toBe(2);
    let outcome: unknown;
    const call = server.bridge.dispatch('firestore_get_document', { path: 'shared/greeting' })
      .then(value => { outcome = value; });
    await expect.poll(() => currentRequests.length).toBe(1);
    const [request] = currentRequests;
    // A controlled old wire counterpart supplies a matching current correlation
    // to verify transport ownership, not to assert request IDs are guessable.
    const oldSocketOpen = oldPeer.readyState === WireSocket.OPEN;
    if (oldSocketOpen) {
      oldPeer.send(JSON.stringify({ type: 'tool-result', id: request.id, ok: true,
        result: { ok: true, summary: 'Stale result' } }));
      // Native WebSocket control pong follows the preceding application frame
      // on this same socket, including when the application ignores stale data.
      const processedOldFrames = once(oldPeer, 'pong');
      oldPeer.ping('processed');
      await processedOldFrames;
      expect(outcome).toBeUndefined();
    }
    currentPeer.send(JSON.stringify({ type: 'tool-result', id: request.id, ok: true,
      result: { ok: true, summary: 'Current result' } }));
    await call;
    expect(outcome).toEqual({ ok: true, summary: 'Current result', data: undefined });
  } finally {
    oldPeer.close();
    currentPeer.close();
    await server.stop();
  }
});

test('browser peer rejects malformed command envelopes before sandbox execution', async ({ page }) => {
  let malformedCommand: string | undefined;
  let deliveredFaults = 0;
  await page.routeWebSocket('**/__pyric/sandbox', route => {
    const server = route.connectToServer();
    server.onMessage(raw => {
      const frame: unknown = JSON.parse(raw.toString());
      const isToolCall = isBridgeMessage(frame) && frame.type === 'tool-call';
      const fault = malformedCommand;
      const changesCommand = isToolCall && fault !== undefined;
      if (changesCommand) {
        malformedCommand = undefined;
        deliveredFaults += 1;
        let invalid: unknown;
        switch (fault) {
          case 'missing-id': invalid = { ...frame, id: undefined }; break;
          case 'name': invalid = { ...frame, name: 3 }; break;
          case 'arguments': invalid = { ...frame, args: [] }; break;
          case 'caller': invalid = { ...frame, callerId: { bad: true } }; break;
          case 'identity': invalid = { ...frame, actAs: { mode: 'unsupported' } }; break;
          case 'worker-op': invalid = { type: 'worker-op', id: frame.id, op: null }; break;
          case 'worker-sub': invalid = { type: 'worker-sub', subId: frame.id, sub: null }; break;
          case 'worker-unsub': invalid = { type: 'worker-unsub', subId: 3 }; break;
          case 'disconnect': invalid = { type: 'worker-client-disconnect', clientSessionId: 3 }; break;
          case 'ping': invalid = { type: 'ping', id: 3 }; break;
          case 'unknown': invalid = { type: 'unsupported' }; break;
          case 'json': route.send('{'); return;
          default: throw new Error('Unknown command fault.');
        }
        route.send(JSON.stringify(invalid));
        return;
      }
      route.send(raw);
    });
  });
  const fixture = await startSoakServe({ flags: ['--no-capture'], extraFiles: {
    'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
    'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
  } });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await waitForPeer(fixture.info.url);
    const mcp = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
    await mcp.initialize();
    const scenarios = ['missing-id', 'name', 'arguments', 'caller', 'identity',
      'worker-op', 'worker-sub', 'worker-unsub', 'disconnect', 'ping', 'unknown', 'json'];
    for (const scenario of scenarios) {
      malformedCommand = scenario;
      let outcome: unknown;
      const call = mcp.toolCall('firestore_create_document', {
        path: `shared/rejected-${scenario}`, data: { scenario }, as: 'admin',
      }).then(value => { outcome = value; });
      await expect.poll(() => outcome, { timeout: 3_000 }).toMatchObject({ ok: false });
      await call;
      const exists = await page.evaluate(async path => {
        const firestore = await import('firebase/firestore');
        return (await firestore.getDoc(firestore.doc(firestore.getFirestore(), path))).exists();
      }, `shared/rejected-${scenario}`);
      expect(exists).toBe(false);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      await waitForPeer(fixture.info.url);
      await expect(mcp.toolCall('firestore_get_document', { path: 'shared/greeting', as: 'admin' }))
        .resolves.toMatchObject({ ok: true });
    }
    expect(deliveredFaults).toBe(scenarios.length);
  } finally {
    await page.close().finally(() => fixture.stop());
  }
});

test('browser peer refuses malformed acknowledgement metadata without a fallback store', async ({ page }) => {
  let corrupted = false;
  const closed = Promise.withResolvers<number>();
  await page.routeWebSocket('**/__pyric/sandbox', route => {
    const server = route.connectToServer();
    server.onMessage(raw => {
      const frame: unknown = JSON.parse(raw.toString());
      const isAck = isBridgeMessage(frame) && frame.type === 'hello-ack';
      const changesAck = isAck && !corrupted;
      if (changesAck) {
        corrupted = true;
        route.send(JSON.stringify({ ...frame, bridgeVersion: { invalid: true } }));
        return;
      }
      route.send(raw);
    });
    route.onClose(async code => {
      await server.close();
      closed.resolve(code);
    });
  });
  const fixture = await startSoakServe({ flags: ['--no-capture'], extraFiles: {
    'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
    'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
  } });
  try {
    let closeCode: number | undefined;
    const refusal = closed.promise.then(code => { closeCode = code; });
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await expect.poll(() => closeCode, { timeout: 3_000 }).toEqual(expect.any(Number));
    await refusal;
    expect(await page.evaluate(() => globalThis.__pyricRuntime?.getSnapshot().mode)).toBe('shared-worker');
    await page.locator('#write').click();
    await expect(page.locator('#write-result')).toHaveText('Written');
    await waitForPeer(fixture.info.url);
    const mcp = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('firestore_get_document', { path: 'shared/greeting', as: 'admin' }))
      .resolves.toMatchObject({ ok: true });
  } finally {
    await page.close().finally(() => fixture.stop());
  }
});

test('uncorrelatable standalone tool replies settle affected work promptly', async () => {
  const server = await startServer({ port: 0, silent: true, disableAuditLog: true });
  const peer = new WireSocket(`${server.url.replace('http:', 'ws:')}/sandbox`);
  let fault: string | undefined;
  peer.on('message', raw => {
    const frame: unknown = JSON.parse(raw.toString());
    const isCall = isBridgeMessage(frame) && frame.type === 'tool-call';
    if (isCall) {
      const reply: ToolResult = { type: 'tool-result', id: frame.id, ok: true,
        result: { ok: true, summary: 'Wire reply' } };
      const activeFault = fault;
      fault = undefined;
      const corruptsReply = activeFault !== undefined;
      const outgoing = corruptsReply ? malformedResult(reply, activeFault) : reply;
      peer.send(JSON.stringify(outgoing));
    }
  });
  try {
    await once(peer, 'open');
    peer.send(JSON.stringify({ type: 'hello', protocol: 1, sandboxId: 'correlation', tools: ['firestore_get_document'] }));
    await expect.poll(() => server.bridge.isSandboxConnected()).toBe(true);
    for (const scenario of ['missing-id', 'nonstring-id']) {
      fault = scenario;
      let outcome: unknown;
      const call = server.bridge.dispatch('firestore_get_document', { path: 'shared/greeting' })
        .then(value => { outcome = value; });
      await expect.poll(() => outcome, { timeout: 3_000 }).toMatchObject({ ok: false, summary: expect.any(String) });
      await call;
      await expect(server.bridge.dispatch('firestore_get_document', { path: 'shared/healthy' }))
        .resolves.toMatchObject({ ok: true, summary: 'Wire reply' });
    }
  } finally {
    peer.close();
    await server.stop();
  }
});

test('mounted worker relay validates outcomes and terminal snapshots before forwarding', async ({ page }) => {
  let operationFault: string | undefined;
  let subscriptionFault: string | undefined;
  await page.routeWebSocket('**/__pyric/sandbox', route => {
    const server = route.connectToServer();
    route.onMessage(raw => {
      const frame: unknown = JSON.parse(raw.toString());
      const isKnown = isBridgeMessage(frame);
      const opFault = operationFault;
      const corruptsOperation = isKnown && frame.type === 'worker-res' && opFault !== undefined;
      if (corruptsOperation) {
        operationFault = undefined;
        let invalid: unknown;
        switch (opFault) {
          case 'status': invalid = { ...frame, ok: 'yes' }; break;
          case 'error': invalid = { ...frame, ok: false, error: { code: 3, message: null } }; break;
          case 'id': invalid = { ...frame, id: null }; break;
          default: throw new Error('Unknown relay operation fault.');
        }
        server.send(JSON.stringify(invalid));
        return;
      }
      const subFault = subscriptionFault;
      const corruptsSubscription = isKnown && frame.type === 'worker-snap' && subFault !== undefined;
      if (corruptsSubscription) {
        subscriptionFault = undefined;
        let invalid: unknown;
        switch (subFault) {
          case 'value': invalid = { ...frame, value: undefined }; break;
          case 'error': invalid = { ...frame, value: { __error: null } }; break;
          case 'id': invalid = { ...frame, subId: null }; break;
          default: throw new Error('Unknown relay subscription fault.');
        }
        server.send(JSON.stringify(invalid));
        return;
      }
      server.send(raw);
    });
  });
  const fixture = await startSoakServe({ flags: ['--no-capture'], extraFiles: {
    'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
    'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
    'firestore.rules': `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /shared/{document} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}`,
  } });
  let socket: WireSocket | undefined;
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await waitForPeer(fixture.info.url);
    const consumer = new WireSocket(`${fixture.info.url.replace('http:', 'ws:')}/__pyric/sandbox`);
    socket = consumer;
    const replies = new Map<string, BridgeMessage>();
    const snapshots = new Map<string, BridgeMessage[]>();
    let attached = false;
    consumer.on('message', raw => {
      const frame: unknown = JSON.parse(raw.toString());
      const isUnknown = !isBridgeMessage(frame);
      if (isUnknown) return;
      const isAttached = frame.type === 'attach-ack';
      if (isAttached) attached = true;
      const isReply = frame.type === 'worker-res';
      if (isReply) replies.set(frame.id, frame);
      const isSnapshot = frame.type === 'worker-snap';
      if (isSnapshot) {
        const deliveries = snapshots.get(frame.subId) ?? [];
        deliveries.push(frame);
        snapshots.set(frame.subId, deliveries);
      }
    });
    await once(consumer, 'open');
    consumer.send(JSON.stringify({ type: 'attach', protocol: 1, clientSessionId: 'relay-fields' }));
    await expect.poll(() => attached).toBe(true);
    for (const fault of ['status', 'error', 'id']) {
      operationFault = fault;
      const id = `op-${fault}`;
      consumer.send(JSON.stringify({ type: 'worker-op', id, op: { method: 'getDoc', path: 'shared/greeting' } }));
      await expect.poll(() => replies.get(id), { timeout: 3_000 }).toMatchObject({
        ok: false, error: { code: 'unavailable', message: expect.any(String) },
      });
    }
    for (const fault of ['value', 'error', 'id']) {
      subscriptionFault = fault;
      const subId = `sub-${fault}`;
      consumer.send(JSON.stringify({ type: 'worker-sub', subId, sub: { target: { __ref: 'doc', path: 'shared/greeting' } } }));
      await expect.poll(() => snapshots.get(subId), { timeout: 3_000 }).toMatchObject([
        { value: { __error: { code: 'unavailable', message: expect.any(String) } } },
      ]);
      await page.locator('#write').click();
      await expect(page.locator('#write-result')).toHaveText('Written');
      const barrierId = `barrier-${fault}`;
      consumer.send(JSON.stringify({ type: 'worker-op', id: barrierId, op: { method: 'getDoc', path: 'shared/greeting' } }));
      await expect.poll(() => replies.get(barrierId)).toMatchObject({ ok: true });
      expect(snapshots.get(subId)).toHaveLength(1);
    }
  } finally {
    socket?.close();
    await page.close().finally(() => fixture.stop());
  }
});

test('browser peer ignores all reverse directions while a real command completes', async ({ page }) => {
  let injected = false;
  await page.routeWebSocket('**/__pyric/sandbox', route => {
    const server = route.connectToServer();
    server.onMessage(raw => {
      const frame: unknown = JSON.parse(raw.toString());
      const isToolCall = isBridgeMessage(frame) && frame.type === 'tool-call';
      const sendsReverseFrames = isToolCall && !injected;
      if (sendsReverseFrames) {
        injected = true;
        for (const type of ['hello', 'attach', 'attach-ack', 'tool-result', 'worker-message', 'worker-message-result',
          'worker-res', 'worker-snap', 'worker-client-interrupted', 'consumer-presence', 'remote-set-lens',
          'remote-set-lens-ack', 'worker-event', 'pong']) {
          route.send(JSON.stringify({ type }));
        }
      }
      route.send(raw);
    });
  });
  const fixture = await startSoakServe({ flags: ['--no-capture'], extraFiles: {
    'index.html': readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8'),
    'main.js': readFileSync(new URL('./fixture/main.js', import.meta.url), 'utf8'),
  } });
  try {
    await page.goto(fixture.info.url);
    await expect(page.locator('#document')).toHaveText('Empty');
    await waitForPeer(fixture.info.url);
    const mcp = new McpHttpClient(`${fixture.info.url}/__pyric/mcp`);
    await mcp.initialize();
    await expect(mcp.toolCall('firestore_create_document', {
      path: 'shared/greeting', data: { message: 'Directions preserved' }, as: 'admin',
    })).resolves.toMatchObject({ ok: true });
    await expect(page.locator('#document')).toHaveText('Directions preserved');
    expect(injected).toBe(true);
  } finally {
    await page.close().finally(() => fixture.stop());
  }
});

test('standalone applies required request fields after peer registration', async () => {
  const server = await startServer({ port: 0, silent: true, disableAuditLog: true });
  try {
    for (const frame of [
      { type: 'remote-set-lens', id: 'bad-lens', clientSessionId: 'unknown', lens: null },
      { type: 'ping', id: 3 },
    ]) {
      const peer = new WireSocket(`${server.url.replace('http:', 'ws:')}/sandbox`);
      try {
        await once(peer, 'open');
        peer.send(JSON.stringify({ type: 'hello', protocol: 1, sandboxId: 'controls', tools: [] }));
        await expect.poll(() => server.bridge.isSandboxConnected()).toBe(true);
        let closeCode: number | undefined;
        const closing = once(peer, 'close').then(([code]) => { closeCode = code; });
        peer.send(JSON.stringify(frame));
        await expect.poll(() => closeCode, { timeout: 3_000 }).toBe(1002);
        await closing;
      } finally {
        peer.close();
      }
    }
    const sandbox = initializeSandbox();
    const peer = connectBridge(sandbox, { url: `${server.url.replace('http:', 'ws:')}/sandbox` });
    try {
      await expect.poll(() => server.bridge.isSandboxConnected()).toBe(true);
      await expect(server.bridge.dispatch('firestore_get_document', { path: 'shared/greeting', as: 'admin' }))
        .resolves.toMatchObject({ ok: true });
    } finally {
      peer.disconnect();
      sandbox.dispose();
    }
  } finally {
    await server.stop();
  }
});
