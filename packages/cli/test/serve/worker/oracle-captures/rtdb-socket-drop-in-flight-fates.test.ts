import { afterEach, describe, expect, test } from 'bun:test';
import type { BridgeMessage, WorkerOpPayload } from '../../../../src/bridge/protocol.js';
import { remoteSandbox } from '../../../../src/remote/index.js';
import { setHoldDeadlineForTesting as setRemoteHoldDeadline } from '../../../../src/remote/held-calls.js';
import { rtdbFateAtDrop } from '../../../../src/serve/worker/rtdb-drop-fates.js';
import {
  nextId,
  nextSubId,
  openSnapshotSubscription,
  rawRpc,
} from '../../../../src/serve/worker/client/core.js';
import type { ClientDb } from '../../../../src/serve/worker/client/handles.js';
import { setHoldDeadlineForTesting as setWebHoldDeadline } from '../../../../src/serve/worker/client/held-messages.js';
import {
  getHostedFirestore,
  type HostedConnectionState,
} from '../../../../src/serve/worker/client/websocket-connection.js';
import type { InboundMessage } from '../../../../src/serve/worker/protocol.js';
import {
  FORGET_METHODS,
  loadSocketDropObservation,
  RESEND_METHODS,
  trackOutcome,
  waitUntil,
  type HostedFrameRecord,
  type RemoteFrameRecord,
} from './rtdb-socket-drop-in-flight-fates-support.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  setWebHoldDeadline(undefined);
  setRemoteHoldDeadline(undefined);
});

describe('rtdb-modular-socket-drop-in-flight-fates oracle replay (HD1 web hosted & HD2 Node remote)', () => {
  test('rtdbFateAtDrop matches every captured @firebase/database wire drop fate', () => {
    const wave = loadSocketDropObservation().combinedRestoreWave;

    const restoredPaths = new Set(wave.restoredOnReconnect.map((frame) => frame.pathPattern));
    expect(restoredPaths.has('/inflight/set')).toBe(true);
    expect(restoredPaths.has('/inflight/update')).toBe(true);
    expect(restoredPaths.has('/inflight/remove')).toBe(true);
    expect(restoredPaths.has('/inflight/prio/.priority')).toBe(true);
    expect(restoredPaths.has('/inflight/withPrio')).toBe(true);
    expect(restoredPaths.has('/inflight/push/<pushKey>')).toBe(true);
    expect(restoredPaths.has('/inflight/get')).toBe(true);

    for (const method of RESEND_METHODS) {
      expect(rtdbFateAtDrop(method)).toBe('resend');
    }

    expect(wave.inFlightOnDisconnectFates).toEqual({
      setResent: false,
      setSettled: false,
      setWithPriorityResent: false,
      setWithPrioritySettled: false,
      updateResent: false,
      updateSettled: false,
      removeResent: false,
      removeSettled: false,
      cancelResent: false,
      cancelSettled: false,
    });
    for (const method of FORGET_METHODS) {
      expect(rtdbFateAtDrop(method)).toBe('forget');
    }

    expect(wave.inFlightTransactionFate).toEqual({
      commitResent: false,
      settledBeforeReconnectHandshake: true,
      outcome: 'rejected',
      errorName: 'Error',
      errorMessage: 'disconnect',
      hasCode: false,
    });
    expect(rtdbFateAtDrop('rtdb.transactionCommit')).toBe('disconnect');
    expect(rtdbFateAtDrop('storage.getMetadata')).toBe('fail');
  });

  test('HD1 web hosted client replays captured resend, stale-reply ignore, forgotten onDisconnect, and Error("disconnect") fates', async () => {
    const wave = loadSocketDropObservation().combinedRestoreWave;
    const frames: HostedFrameRecord[] = [];
    const sockets = new Map<number, { close(): void; send(data: string): void }>();
    let connSequence = 0;
    let acceptingConnections = true;
    let holdOps = false;

    const server = Bun.serve<{ conn: number }>({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (!acceptingConnections) {
          return new Response('host restarting', { status: 503 });
        }
        connSequence += 1;
        const conn = connSequence;
        if (srv.upgrade(req, { data: { conn } })) {
          return undefined;
        }
        return new Response('upgrade required', { status: 426 });
      },
      websocket: {
        open(ws) {
          sockets.set(ws.data.conn, ws);
        },
        message(ws, raw) {
          const conn = ws.data.conn;
          const msg = JSON.parse(String(raw)) as BridgeMessage;
          if (msg.type === 'attach') {
            ws.send(
              JSON.stringify({
                type: 'attach-ack',
                protocol: 1,
                bridgeVersion: 'test',
                peerConnected: true,
                clientSessionId: `client-${conn}`,
                projectKey: 'orbit',
                hostInstanceId: 'host-1',
                capabilities: ['worker-port'],
              } satisfies BridgeMessage),
            );
            return;
          }
          if (msg.type !== 'worker-message') {
            return;
          }
          const inner = msg.message as {
            t: string;
            id?: string;
            subId?: string;
            method?: string;
            call?: string;
          };
          if (inner.t === 'sub') {
            let subIdText = '';
            if (typeof inner.subId === 'string') {
              subIdText = inner.subId;
            }
            frames.push({
              conn,
              kind: 'sub',
              id: subIdText,
              callId: subIdText,
              method: 'sub',
            });
            return;
          }
          if (inner.t !== 'op' || typeof inner.id !== 'string' || typeof inner.method !== 'string') {
            return;
          }
          let callId = inner.id;
          if (typeof inner.call === 'string') {
            callId = inner.call;
          }
          frames.push({
            conn,
            kind: 'op',
            id: inner.id,
            callId,
            method: inner.method,
          });
          if (holdOps) {
            return;
          }
          let responseValue: unknown = 'ok';
          if (inner.method === 'rtdb.get') {
            responseValue = wave.settledAfterReconnectReplies.getResolvedValue;
          }
          ws.send(
            JSON.stringify({
              type: 'worker-message-result',
              message: { t: 'res', id: inner.id, ok: true, value: responseValue },
            }),
          );
        },
      },
    });
    cleanups.push(() => {
      void server.stop(true);
    });

    const states: HostedConnectionState[] = [];
    const db: ClientDb = getHostedFirestore({
      url: `ws://127.0.0.1:${server.port}/__pyric/sandbox`,
      projectKey: 'orbit',
      retryInitialConnection: true,
      onConnection: (state) => states.push(state),
    });
    cleanups.push(() => db.port.close());

    await waitUntil(() => states.includes('attached'), 'initial web hosted attach');

    const subId = nextSubId();
    openSnapshotSubscription(
      db.port,
      subId,
      { port: db.port, next: () => {}, service: 'firestore' },
      { t: 'sub', subId, target: { kind: 'doc', path: 'watched/node' } } as unknown as InboundMessage,
    );
    await waitUntil(() => frames.some((f) => f.conn === 1 && f.kind === 'sub'), 'initial sub');

    holdOps = true;
    const issueOp = (method: string) => {
      const id = nextId();
      const promise = rawRpc(db.port, {
        t: 'op',
        id,
        method,
        call: id,
      } as unknown as InboundMessage);
      return { id, method, tracked: trackOutcome(promise) };
    };

    const inFlightResends = RESEND_METHODS.map((method) => issueOp(method));
    const inFlightForgets = FORGET_METHODS.map((method) => issueOp(method));
    const inFlightTx = issueOp('rtdb.transactionCommit');

    await waitUntil(
      () => frames.filter((f) => f.conn === 1 && f.kind === 'op').length === 12,
      '12 in-flight ops on connection 1',
    );

    acceptingConnections = false;
    sockets.get(1)?.close();
    await waitUntil(() => states.at(-1) === 'interrupted', 'web client interrupted');
    await waitUntil(() => inFlightTx.tracked.settled, 'in-flight tx settled on drop');

    expect(inFlightTx.tracked.error).toBeInstanceOf(Error);
    expect(inFlightTx.tracked.error?.name).toBe(wave.inFlightTransactionFate.errorName);
    expect(inFlightTx.tracked.error?.message).toBe(wave.inFlightTransactionFate.errorMessage);
    expect(inFlightTx.tracked.error?.code !== undefined).toBe(wave.inFlightTransactionFate.hasCode);

    const postDropWrite = issueOp('rtdb.set');

    acceptingConnections = true;
    await waitUntil(
      () => states.filter((s) => s === 'attached').length >= 2,
      'web client reattached',
    );
    await waitUntil(
      () => frames.filter((f) => f.conn >= 2).length >= 9,
      'restored sub + 7 resends + post-drop set',
    );

    const conn2Socket = sockets.get(connSequence);
    const conn2Frames = frames.filter((f) => f.conn === connSequence);
    expect(conn2Frames.map((f) => f.method)).toEqual([
      'sub',
      ...RESEND_METHODS,
      'rtdb.set',
    ]);

    const setCall = inFlightResends[0];
    const getCall = inFlightResends[6];
    if (!conn2Socket || !setCall || !getCall) {
      throw new Error('Expected reconnect socket and tracked set/get calls');
    }

    for (const resent of inFlightResends) {
      const conn2Copy = conn2Frames.find((f) => f.callId === resent.id);
      expect(conn2Copy).toBeDefined();
      expect(conn2Copy?.id).not.toBe(resent.id);
    }

    // Stale replies to connection 1 request IDs settle nothing, matching the capture.
    conn2Socket.send(
      JSON.stringify({
        type: 'worker-message-result',
        message: { t: 'res', id: setCall.id, ok: true, value: 'stale' },
      }),
    );
    conn2Socket.send(
      JSON.stringify({
        type: 'worker-message-result',
        message: { t: 'res', id: getCall.id, ok: true, value: { stale: true } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(!setCall.tracked.settled).toBe(wave.staleWriteReplyToOldRequestIdIgnored);
    expect(!getCall.tracked.settled).toBe(wave.staleGetReplyToOldRequestIdIgnored);

    holdOps = false;
    for (const frame of conn2Frames) {
      if (frame.kind !== 'op') {
        continue;
      }
      let value: unknown = 'ok';
      if (frame.method === 'rtdb.get') {
        value = wave.settledAfterReconnectReplies.getResolvedValue;
      }
      conn2Socket.send(
        JSON.stringify({
          type: 'worker-message-result',
          message: { t: 'res', id: frame.id, ok: true, value },
        }),
      );
    }

    await waitUntil(
      () => inFlightResends.every((c) => c.tracked.settled) && postDropWrite.tracked.settled,
      'resent and post-drop calls settled',
    );
    expect(getCall.tracked.value).toEqual(wave.settledAfterReconnectReplies.getResolvedValue);

    for (const forgotten of inFlightForgets) {
      expect(forgotten.tracked.settled).toBe(false);
      expect(conn2Frames.some((f) => f.callId === forgotten.id)).toBe(false);
    }
    expect(conn2Frames.some((f) => f.callId === inFlightTx.id)).toBe(
      wave.inFlightTransactionFate.commitResent,
    );
  });

  test('HD2 Node remote client replays captured resend, preserved keyed push vs keyless push fail, forgotten onDisconnect, and Error("disconnect") fates', async () => {
    const wave = loadSocketDropObservation().combinedRestoreWave;
    const frames: RemoteFrameRecord[] = [];
    const sockets = new Map<number, { close(): void; send(data: string): void }>();
    let connSequence = 0;
    let acceptingConnections = true;
    let holdOps = false;

    const server = Bun.serve<{ conn: number }>({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (!acceptingConnections) {
          return new Response('host restarting', { status: 503 });
        }
        connSequence += 1;
        const conn = connSequence;
        if (srv.upgrade(req, { data: { conn } })) {
          return undefined;
        }
        return new Response('upgrade required', { status: 426 });
      },
      websocket: {
        open(ws) {
          sockets.set(ws.data.conn, ws);
        },
        message(ws, raw) {
          const conn = ws.data.conn;
          const msg = JSON.parse(String(raw)) as BridgeMessage;
          if (msg.type === 'attach') {
            ws.send(
              JSON.stringify({
                type: 'attach-ack',
                protocol: 1,
                bridgeVersion: 'test',
                peerConnected: true,
                clientSessionId: `node-${conn}`,
              } satisfies BridgeMessage),
            );
            return;
          }
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', id: msg.id } satisfies BridgeMessage));
            return;
          }
          if (msg.type === 'worker-sub') {
            frames.push({
              conn,
              kind: 'sub',
              id: msg.subId,
              method: 'sub',
              key: undefined,
            });
            ws.send(
              JSON.stringify({
                type: 'worker-snap',
                subId: msg.subId,
                value: { key: 'node', exists: true, value: { seeded: true }, size: 1 },
              } satisfies BridgeMessage),
            );
            return;
          }
          if (msg.type !== 'worker-op') {
            return;
          }
          const payload = msg.op as WorkerOpPayload & { key?: string };
          frames.push({
            conn,
            kind: 'op',
            id: msg.id,
            method: payload.method,
            key: payload.key,
          });
          if (holdOps) {
            return;
          }
          let replyVal: unknown = null;
          if (payload.method === 'rtdb.get') {
            replyVal = {
              key: 'get',
              exists: true,
              value: wave.settledAfterReconnectReplies.getResolvedValue,
              size: 1,
            };
          }
          ws.send(
            JSON.stringify({
              type: 'worker-res',
              id: msg.id,
              ok: true,
              value: replyVal,
            } satisfies BridgeMessage),
          );
        },
      },
    });
    cleanups.push(() => {
      void server.stop(true);
    });

    const warnings: string[] = [];
    const lazy = remoteSandbox({
      url: `http://127.0.0.1:${server.port}`,
      warn: (message) => warnings.push(message),
    });
    cleanups.push(() => lazy.close());

    const liveValues: unknown[] = [];
    lazy.rtdb.onValue('watched/node', (snap) => liveValues.push(snap.value));
    await waitUntil(() => liveValues.length === 1, 'initial remote onValue');

    // Advance connection 1's per-core opCounter (`rop-1`) before holding ops so
    // every in-flight op on connection 1 (`rop-2..rop-14`) differs from its
    // re-issued ID on connection 2 (`rop-1..rop-7`).
    await lazy.rtdb.set('warmup/ready', true);

    holdOps = true;
    const mintedKey = '-O0123456789abcdefgh';
    expect(mintedKey.length).toBe(wave.pushKeyStability.keyLength);

    const setTrack = trackOutcome(lazy.rtdb.set('inflight/set', { v: 1 }));
    const updateTrack = trackOutcome(lazy.rtdb.update('inflight/update', { u: 2 }));
    const removeTrack = trackOutcome(lazy.rtdb.remove('inflight/remove'));
    const prioTrack = trackOutcome(
      lazy.channel.op({ method: 'rtdb.setPriority', instance: undefined, path: 'inflight/prio', priority: 5 }),
    );
    const withPrioTrack = trackOutcome(
      lazy.channel.op({
        method: 'rtdb.setWithPriority',
        instance: undefined,
        path: 'inflight/withPrio',
        value: 'val',
        priority: 9,
      }),
    );
    const keyedPushTrack = trackOutcome(
      lazy.channel.op({
        method: 'rtdb.push',
        instance: undefined,
        path: 'inflight/push',
        key: mintedKey,
        value: { item: true },
      }),
    );
    const keylessPushTrack = trackOutcome(lazy.rtdb.push('inflight/pushKeyless', { item: true }));
    const getTrack = trackOutcome(lazy.rtdb.get('inflight/get'));
    const forgetTracks = FORGET_METHODS.map((method) =>
      trackOutcome(lazy.channel.op({ method, instance: undefined, path: 'inflight/od' } as WorkerOpPayload)),
    );
    const txTrack = trackOutcome(
      lazy.channel.op({
        method: 'rtdb.transactionCommit',
        instance: undefined,
        path: 'tx/item',
        expected: 10,
        value: 11,
      } as WorkerOpPayload),
    );

    await waitUntil(
      () => frames.filter((f) => f.conn === 1 && f.kind === 'op').length === 14,
      'warmup + 13 in-flight ops on remote connection 1',
    );

    acceptingConnections = false;
    sockets.get(1)?.close();
    await waitUntil(() => warnings.length === 1, 'remote disconnect warning');
    await waitUntil(() => txTrack.settled && keylessPushTrack.settled, 'tx and keyless push settled');

    expect(txTrack.error?.name).toBe(wave.inFlightTransactionFate.errorName);
    expect(txTrack.error?.message).toBe(wave.inFlightTransactionFate.errorMessage);
    expect(txTrack.error?.code !== undefined).toBe(wave.inFlightTransactionFate.hasCode);
    expect(keylessPushTrack.error?.code).toBe('unavailable');

    const postDropSetTrack = trackOutcome(lazy.rtdb.set('queued/setWhileDown', { after: true }));

    acceptingConnections = true;
    await waitUntil(
      () => connSequence >= 2 && frames.filter((f) => f.conn === connSequence).length >= 9,
      'remote restored sub + 7 resends + post-drop set',
    );

    const conn1InFlight = frames.filter((f) => f.conn === 1 && f.kind === 'op').slice(1);
    const conn2Frames = frames.filter((f) => f.conn === connSequence);
    const conn2Ops = conn2Frames.filter((f) => f.kind === 'op');
    expect(conn2Frames.map((f) => f.method)).toEqual([
      'sub',
      ...RESEND_METHODS,
      'rtdb.set',
    ]);
    const resentPush = conn2Ops.find((f) => f.method === 'rtdb.push');
    expect(resentPush?.key).toBe(mintedKey);

    for (let i = 0; i < RESEND_METHODS.length; i += 1) {
      const method = RESEND_METHODS[i];
      const conn1Copy = conn1InFlight.find((f) => f.method === method);
      const conn2Copy = conn2Ops[i];
      expect(conn1Copy).toBeDefined();
      expect(conn2Copy).toBeDefined();
      expect(conn2Copy?.id).not.toBe(conn1Copy?.id);
    }

    const conn2Socket = sockets.get(connSequence);
    const conn1Get = conn1InFlight.find((f) => f.method === 'rtdb.get');
    const conn1Tx = conn1InFlight.find((f) => f.method === 'rtdb.transactionCommit');
    if (!conn2Socket || !conn1Get || !conn1Tx) {
      throw new Error('Expected remote reconnect socket and connection 1 get/tx frames');
    }
    // Replies carrying unallocated connection 1 request IDs (`rop-9`, `rop-14`)
    // hit `RemoteSandboxCore`'s `isLateReply` guard and settle nothing.
    conn2Socket.send(
      JSON.stringify({
        type: 'worker-res',
        id: conn1Get.id,
        ok: true,
        value: { key: 'get', exists: true, value: { stale: true }, size: 1 },
      } satisfies BridgeMessage),
    );
    conn2Socket.send(
      JSON.stringify({
        type: 'worker-res',
        id: conn1Tx.id,
        ok: true,
        value: null,
      } satisfies BridgeMessage),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(!getTrack.settled).toBe(wave.staleGetReplyToOldRequestIdIgnored);
    expect(!setTrack.settled).toBe(wave.staleWriteReplyToOldRequestIdIgnored);

    holdOps = false;
    for (const frame of conn2Ops) {
      let replyVal: unknown = null;
      if (frame.method === 'rtdb.get') {
        replyVal = {
          key: 'get',
          exists: true,
          value: wave.settledAfterReconnectReplies.getResolvedValue,
          size: 1,
        };
      }
      conn2Socket.send(
        JSON.stringify({
          type: 'worker-res',
          id: frame.id,
          ok: true,
          value: replyVal,
        } satisfies BridgeMessage),
      );
    }

    const expectedResolved = [
      setTrack,
      updateTrack,
      removeTrack,
      prioTrack,
      withPrioTrack,
      keyedPushTrack,
      getTrack,
      postDropSetTrack,
    ];
    await waitUntil(() => expectedResolved.every((t) => t.settled), 'all remote resends settled');
    expect(getTrack.value).toEqual(wave.settledAfterReconnectReplies.getResolvedValue);

    for (const forgotten of forgetTracks) {
      expect(forgotten.settled).toBe(false);
    }
    expect(conn2Ops.some((f) => FORGET_METHODS.includes(f.method as (typeof FORGET_METHODS)[number]))).toBe(false);
    expect(conn2Ops.some((f) => f.method === 'rtdb.transactionCommit')).toBe(
      wave.inFlightTransactionFate.commitResent,
    );
  });
});
