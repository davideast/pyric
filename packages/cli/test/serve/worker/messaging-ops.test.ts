/**
 * SharedWorker host — messaging ops/subs (the broker's worker-host seam).
 *
 * Same harness style as host.test.ts: REAL sandbox + fake ports, no browser.
 * Covers: the host capability gate (`messaging/disabled`), token lifecycle over the
 * wire, send-plane accepts + captured rejection envelopes (verbatim, never
 * re-derived), topic management, the deliver driver, and THE captured
 * routing rule crossing the transport — per-port visibility mapped to
 * broker client state (foreground iff ANY visible client; a hidden tab's
 * port marks its client not-visible).
 */

import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import {
  noTargetEnvelope,
  invalidTopicNameEnvelope,
  unregisteredTokenEnvelope,
  TOKEN_LENGTH,
} from 'pyric/messaging/internal';

import {
  handleMessage,
  cleanupPort,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
  SnapMessage,
} from '../../../src/serve/worker/protocol.js';

// ─── Harness ────────────────────────────────────────────────────────────────

function fakePort(): PortLike & { messages: OutboundMessage[]; snaps: SnapMessage[] } {
  const messages: OutboundMessage[] = [];
  const snaps: SnapMessage[] = [];
  return {
    messages,
    snaps,
    postMessage(msg: OutboundMessage) {
      messages.push(msg);
      if (msg.t === 'snap') snaps.push(msg);
    },
  };
}

type FakePort = ReturnType<typeof fakePort>;

function makeCtx(enabled = true): HostCtx {
  const sandbox = initializeSandbox();
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'messaging-ops-test',
    subs: new Map(),
    ...(enabled ? { messagingEnabled: true } : {}),
  };
}

let seq = 0;
async function op(
  ctx: HostCtx,
  port: FakePort,
  payload: Record<string, unknown>,
): Promise<ResMessage> {
  const id = `mop-${++seq}`;
  await handleMessage(ctx, port, { ...payload, t: 'op', id } as InboundMessage);
  const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
  if (!res) throw new Error(`no res for ${id}`);
  return res;
}

async function opOk(ctx: HostCtx, port: FakePort, payload: Record<string, unknown>): Promise<unknown> {
  const res = await op(ctx, port, payload);
  if (!res.ok) throw new Error(`expected ok: ${res.error.code} — ${res.error.message}`);
  return res.value;
}

async function opFail(ctx: HostCtx, port: FakePort, payload: Record<string, unknown>) {
  const res = await op(ctx, port, payload);
  if (res.ok) throw new Error(`expected failure, got: ${JSON.stringify(res.value)}`);
  return res.error;
}

function sub(ctx: HostCtx, port: FakePort, subId: string, target: string): Promise<void> {
  return handleMessage(ctx, port, { t: 'sub', subId, target } as InboundMessage);
}

async function mintToken(ctx: HostCtx, port: FakePort, registrationId = 'swreg-a'): Promise<string> {
  const value = (await opOk(ctx, port, { method: 'messaging.getToken', registrationId })) as {
    token: string;
  };
  return value.token;
}

// ─── The host capability gate ───────────────────────────────────────────────

describe('host capability gate', () => {
  it('ops answer messaging/disabled when the ctx flag is off', async () => {
    const ctx = makeCtx(false);
    const port = fakePort();
    const err = await opFail(ctx, port, { method: 'messaging.getToken' });
    expect(err.code).toBe('messaging/disabled');
    expect(err.message).toContain('messagingEnabled: true');
  });

  it('subs deliver the gate as a snap __error', async () => {
    const ctx = makeCtx(false);
    const port = fakePort();
    await sub(ctx, port, 's1', 'messaging.foreground');
    const snap = port.snaps[0]!;
    expect((snap.value as { __error: { code: string } }).__error.code).toBe('messaging/disabled');
  });
});

// ─── Token lifecycle over the wire ──────────────────────────────────────────

describe('token lifecycle', () => {
  it('mints the captured token shape, stable per registration', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const first = await mintToken(ctx, port);
    const again = await mintToken(ctx, port);
    expect(first.length).toBe(TOKEN_LENGTH);
    expect(first.includes(':')).toBe(true);
    expect(again).toBe(first);
    const other = await mintToken(ctx, port, 'swreg-b');
    expect(other).not.toBe(first);
  });

  it('deleteToken resolves truthy; a send to the dead token answers the UNREGISTERED envelope', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const token = await mintToken(ctx, port);
    expect(await opOk(ctx, port, { method: 'messaging.deleteToken', registrationId: 'swreg-a' })).toBe(true);
    const err = await opFail(ctx, port, { method: 'messaging.send', message: { token } });
    expect(err.code).toBe('NOT_FOUND');
    expect(err.envelope).toEqual(unregisteredTokenEnvelope());
  });
});

// ─── Send plane: accepts, dryRun parity, rejection envelopes ────────────────

describe('messaging.send', () => {
  it('accepts a token send and replies the broker resource name', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const token = await mintToken(ctx, port);
    const accepted = (await opOk(ctx, port, {
      method: 'messaging.send',
      message: { token, data: { k: 'v' } },
    })) as { name: string; messageId: string; validateOnly: boolean };
    expect(accepted.name).toMatch(/^projects\/pyric-sandbox\/messages\//);
    expect(accepted.validateOnly).toBe(false);
  });

  it('validateOnly runs the same validation and delivers nothing', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const token = await mintToken(ctx, port);
    await opOk(ctx, port, { method: 'messaging.setVisibility', state: 'visible' });
    await sub(ctx, port, 'fg', 'messaging.foreground');
    const accepted = (await opOk(ctx, port, {
      method: 'messaging.send',
      message: { token, data: { k: 'v' } },
      validateOnly: true,
    })) as { validateOnly: boolean };
    expect(accepted.validateOnly).toBe(true);
    expect(port.snaps.length).toBe(0);
  });

  it('rejections cross the wire as the captured envelope, dryRun identical', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const real = await opFail(ctx, port, { method: 'messaging.send', message: {} });
    const dry = await opFail(ctx, port, { method: 'messaging.send', message: {}, validateOnly: true });
    expect(real.envelope).toEqual(noTargetEnvelope());
    expect(real.code).toBe('INVALID_ARGUMENT');
    expect(dry.envelope).toEqual(real.envelope);
  });
});

// ─── Topic management ───────────────────────────────────────────────────────

describe('topic management', () => {
  it('subscribe/unsubscribe report per-token outcomes and gate topic routing', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const token = await mintToken(ctx, port);
    await opOk(ctx, port, { method: 'messaging.setVisibility', state: 'visible' });
    await sub(ctx, port, 'fg', 'messaging.foreground');

    const outcome = (await opOk(ctx, port, {
      method: 'messaging.subscribeToTopic',
      tokens: [token, 'not-a-token'],
      topic: 'news',
    })) as { successCount: number; failureCount: number; errors: Array<{ reason: string }> };
    expect(outcome.successCount).toBe(1);
    expect(outcome.errors[0]!.reason).toBe('invalid-token');

    await opOk(ctx, port, { method: 'messaging.send', message: { topic: 'news', data: { t: '1' } } });
    expect(port.snaps.length).toBe(1);

    await opOk(ctx, port, { method: 'messaging.unsubscribeFromTopic', tokens: [token], topic: 'news' });
    await opOk(ctx, port, { method: 'messaging.send', message: { topic: 'news', data: { t: '2' } } });
    expect(port.snaps.length).toBe(1); // no recipient — nothing delivered
  });

  it('an invalid topic name answers the captured envelope', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    const err = await opFail(ctx, port, {
      method: 'messaging.subscribeToTopic',
      tokens: [],
      topic: 'bad topic!',
    });
    expect(err.envelope).toEqual(invalidTopicNameEnvelope());
  });
});

// ─── THE captured routing rule crossing the transport ──────────────────────

describe('per-port visibility routing', () => {
  it('a hidden tab’s port marks its client not-visible — deliveries route background', async () => {
    const ctx = makeCtx();
    const pageA = fakePort();
    const swPort = fakePort();
    const token = await mintToken(ctx, pageA);
    await sub(ctx, pageA, 'fg', 'messaging.foreground');
    await sub(ctx, swPort, 'bg', 'messaging.background');

    await opOk(ctx, pageA, { method: 'messaging.setVisibility', state: 'visible' });
    await opOk(ctx, pageA, {
      method: 'messaging.send',
      message: { token, notification: { title: 'fg' } },
    });
    expect(pageA.snaps.length).toBe(1);
    expect(swPort.snaps.length).toBe(0);
    const payload = pageA.snaps[0]!.value as { from: string; messageId: string; notification: { title: string } };
    // Captured payload shape: from is the sender id, messageId present.
    expect(payload.from).toBe('999999999999');
    expect(typeof payload.messageId).toBe('string');
    expect(payload.notification.title).toBe('fg');

    await opOk(ctx, pageA, { method: 'messaging.setVisibility', state: 'hidden' });
    await opOk(ctx, pageA, {
      method: 'messaging.send',
      message: { token, notification: { title: 'bg' } },
    });
    expect(pageA.snaps.length).toBe(1); // no new foreground delivery
    expect(swPort.snaps.length).toBe(1);
    expect((swPort.snaps[0]!.value as { notification: { title: string } }).notification.title).toBe('bg');
  });

  it('foreground iff ANY visible client — one visible tab keeps routing foreground', async () => {
    const ctx = makeCtx();
    const hiddenTab = fakePort();
    const visibleTab = fakePort();
    const token = await mintToken(ctx, hiddenTab);
    await sub(ctx, hiddenTab, 'fg-h', 'messaging.foreground');
    await sub(ctx, hiddenTab, 'bg-h', 'messaging.background');

    await opOk(ctx, hiddenTab, { method: 'messaging.setVisibility', state: 'hidden' });
    await opOk(ctx, visibleTab, { method: 'messaging.setVisibility', state: 'visible' });
    await opOk(ctx, hiddenTab, { method: 'messaging.send', message: { token, data: { x: '1' } } });

    const routes = hiddenTab.snaps.map((s) => s.subId);
    expect(routes).toEqual(['fg-h']); // foreground handlers fire, background do not
  });

  it('cleanupPort removes the port’s broker client and its delivery subs', async () => {
    const ctx = makeCtx();
    const visibleTab = fakePort();
    const swPort = fakePort();
    const token = await mintToken(ctx, swPort);
    await sub(ctx, visibleTab, 'fg', 'messaging.foreground');
    await sub(ctx, swPort, 'bg', 'messaging.background');
    await opOk(ctx, visibleTab, { method: 'messaging.setVisibility', state: 'visible' });
    await opOk(ctx, swPort, { method: 'messaging.setVisibility', state: 'hidden' });

    cleanupPort(ctx, visibleTab);

    await opOk(ctx, swPort, { method: 'messaging.send', message: { token, data: { x: '1' } } });
    // The closed visible tab no longer pins foreground routing…
    expect(swPort.snaps.map((s) => s.subId)).toEqual(['bg']);
    // …and its own handler sub is gone.
    expect(visibleTab.snaps.length).toBe(0);
  });
});

// ─── The deliver driver + unsub ─────────────────────────────────────────────

describe('messaging.deliver and unsub', () => {
  it('deliver injects into the client plane and routes by current visibility', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    await sub(ctx, port, 'fg', 'messaging.foreground');
    await opOk(ctx, port, { method: 'messaging.setVisibility', state: 'visible' });
    const result = (await opOk(ctx, port, {
      method: 'messaging.deliver',
      spec: { data: { tag: 'drive' }, from: '42' },
    })) as { route: string; handlerCount: number; payload: { from: string; data: { tag: string } } };
    expect(result.route).toBe('foreground');
    expect(result.handlerCount).toBe(1);
    expect(result.payload.from).toBe('42');
    expect((port.snaps[0]!.value as { data: { tag: string } }).data.tag).toBe('drive');
  });

  it('deliver with visibility: visible sets THIS port visible then routes foreground', async () => {
    // The transport twin of pyric/messaging `sandbox.deliver({ visibilityState })`:
    // a fresh port with no prior setVisibility still lands foreground because
    // the spec sets its client visible before routing (issue #397).
    const ctx = makeCtx();
    const page = fakePort();
    const swPort = fakePort();
    await sub(ctx, page, 'fg', 'messaging.foreground');
    await sub(ctx, swPort, 'bg', 'messaging.background');
    const result = (await opOk(ctx, page, {
      method: 'messaging.deliver',
      spec: { visibilityState: 'visible', data: { tag: 'fg' } },
    })) as { route: string; handlerCount: number };
    expect(result.route).toBe('foreground');
    expect(page.snaps.map((s) => s.subId)).toEqual(['fg']);
    expect(swPort.snaps.length).toBe(0);
  });

  it('deliver with visibility: hidden routes background (onBackgroundMessage)', async () => {
    const ctx = makeCtx();
    const page = fakePort();
    const swPort = fakePort();
    await sub(ctx, page, 'fg', 'messaging.foreground');
    await sub(ctx, swPort, 'bg', 'messaging.background');
    // The delivering page was visible a moment ago…
    await opOk(ctx, page, { method: 'messaging.setVisibility', state: 'visible' });
    const result = (await opOk(ctx, page, {
      method: 'messaging.deliver',
      spec: { visibilityState: 'hidden', notification: { title: 'bg' } },
    })) as { route: string };
    // …but the spec's hidden visibility wins for this delivery.
    expect(result.route).toBe('background');
    expect(swPort.snaps.map((s) => s.subId)).toEqual(['bg']);
    expect(page.snaps.length).toBe(0);
  });

  it('deliver without visibilityState leaves last-reported visibility untouched', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    await sub(ctx, port, 'fg', 'messaging.foreground');
    await opOk(ctx, port, { method: 'messaging.setVisibility', state: 'visible' });
    const result = (await opOk(ctx, port, {
      method: 'messaging.deliver',
      spec: { data: { n: '1' } },
    })) as { route: string };
    expect(result.route).toBe('foreground');
  });

  it('unsub stops delivery; duplicate sub ids are idempotent', async () => {
    const ctx = makeCtx();
    const port = fakePort();
    await sub(ctx, port, 'fg', 'messaging.foreground');
    await sub(ctx, port, 'fg', 'messaging.foreground'); // idempotent — one handler
    await opOk(ctx, port, { method: 'messaging.setVisibility', state: 'visible' });
    await opOk(ctx, port, { method: 'messaging.deliver', spec: { data: { n: '1' } } });
    expect(port.snaps.length).toBe(1);

    await handleMessage(ctx, port, { t: 'unsub', subId: 'fg' });
    await opOk(ctx, port, { method: 'messaging.deliver', spec: { data: { n: '2' } } });
    expect(port.snaps.length).toBe(1);
  });
});
