import type { Probe } from '../../rigs/types.ts';

export interface CapturedWireFrameShape {
  action: string;
  pathPattern: string;
  conditionalHash: boolean;
}

export interface CapturedRestoredWireFrameShape extends CapturedWireFrameShape {
  newRequestIdGreaterThanMaxBeforeDrop: boolean;
}

export interface CapturedPushKeyStability {
  keyLength: number;
  matchesPushCharset: boolean;
  resentIdenticalKey: boolean;
}

export interface CapturedInFlightOnDisconnectFates {
  setResent: boolean;
  setSettled: boolean;
  setWithPriorityResent: boolean;
  setWithPrioritySettled: boolean;
  updateResent: boolean;
  updateSettled: boolean;
  removeResent: boolean;
  removeSettled: boolean;
  cancelResent: boolean;
  cancelSettled: boolean;
}

export interface CapturedInFlightTransactionFate {
  commitResent: boolean;
  settledBeforeReconnectHandshake: boolean;
  outcome: 'resolved' | 'rejected';
  errorName: string | null;
  errorMessage: string | null;
  hasCode: boolean;
}

export interface SocketDropInFlightFatesObservation {
  combinedRestoreWave: {
    sentBeforeDrop: CapturedWireFrameShape[];
    restoredOnReconnect: CapturedRestoredWireFrameShape[];
    pushKeyStability: CapturedPushKeyStability;
    staleWriteReplyToOldRequestIdIgnored: boolean;
    staleGetReplyToOldRequestIdIgnored: boolean;
    settledAfterReconnectReplies: {
      setResolved: boolean;
      updateResolved: boolean;
      removeResolved: boolean;
      setPriorityResolved: boolean;
      setWithPriorityResolved: boolean;
      pushResolved: boolean;
      getResolvedValue: unknown;
      queuedWhileDisconnectedSetResolved: boolean;
      queuedWhileDisconnectedOnDisconnectResolved: boolean;
    };
    inFlightOnDisconnectFates: CapturedInFlightOnDisconnectFates;
    inFlightTransactionFate: CapturedInFlightTransactionFate;
  };
}

interface RawWireFrame {
  conn: number;
  r: number;
  a: string;
  p: string;
  conditionalHash: boolean;
}

interface ServerSocketHandle {
  close(): void;
  send(message: string): void;
}

const PUSH_KEY_CHARSET_RE = /^[-0-9A-Za-z_]{20}$/;

function scrubPushKeyInPath(rawPath: string, pushKey: string): string {
  if (pushKey.length > 0 && rawPath.endsWith(`/${pushKey}`)) {
    return `${rawPath.slice(0, rawPath.length - pushKey.length)}<pushKey>`;
  }
  return rawPath;
}

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sendHandshake(ws: ServerSocketHandle, port: number, conn: number): void {
  ws.send(
    JSON.stringify({
      t: 'c',
      d: {
        t: 'h',
        d: {
          ts: 1700000000000,
          v: '5',
          h: `127.0.0.1:${port}`,
          s: `sess-${conn}`,
        },
      },
    }),
  );
}

let probeRunSequence = 0;

export async function observeSocketDropInFlightFates(): Promise<SocketDropInFlightFatesObservation> {
  const [appMod, dbMod] = await Promise.all([
    import('firebase/app'),
    import('firebase/database'),
  ]);

  probeRunSequence += 1;
  const appName = `socket-drop-fates-${probeRunSequence}`;

  const frames: RawWireFrame[] = [];
  const sockets = new Map<number, ServerSocketHandle>();
  let connSequence = 0;
  let holdDataFrames = false;
  let holdReconnectHandshake = false;
  let pendingHandshakeConn: number | null = null;
  let serverPort = 0;

  const server = Bun.serve<{ conn: number }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      connSequence += 1;
      const conn = connSequence;
      if (srv.upgrade(req, { data: { conn } })) {
        return undefined;
      }
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open(ws) {
        const { conn } = ws.data;
        sockets.set(conn, ws);
        if (conn > 1 && holdReconnectHandshake) {
          pendingHandshakeConn = conn;
          return;
        }
        sendHandshake(ws, serverPort, conn);
      },
      message(ws, rawMessage) {
        const { conn } = ws.data;
        const parsed = JSON.parse(String(rawMessage)) as {
          t?: unknown;
          d?: {
            r?: unknown;
            a?: unknown;
            b?: { p?: unknown; h?: unknown };
          };
        };
        if (parsed.t !== 'd' || !parsed.d) {
          return;
        }
        const r = parsed.d.r;
        const a = parsed.d.a;
        if (typeof r !== 'number' || typeof a !== 'string') {
          return;
        }
        if (a === 's') {
          ws.send(JSON.stringify({ t: 'd', d: { r, b: { s: 'ok', d: {} } } }));
          return;
        }
        let p = '';
        if (parsed.d.b && typeof parsed.d.b.p === 'string') {
          p = parsed.d.b.p;
        }
        const hasStringHash = Boolean(parsed.d.b && typeof parsed.d.b.h === 'string');
        frames.push({
          conn,
          r,
          a,
          p,
          conditionalHash: hasStringHash,
        });

        if (holdDataFrames) {
          if (conn === 1 && a === 'q' && p === '/tx/item') {
            ws.send(JSON.stringify({ t: 'd', d: { a: 'd', b: { p: '/tx/item', d: 10 } } }));
            ws.send(JSON.stringify({ t: 'd', d: { r, b: { s: 'ok', d: {} } } }));
          }
          return;
        }

        if (a === 'q') {
          ws.send(JSON.stringify({ t: 'd', d: { a: 'd', b: { p, d: { seeded: true } } } }));
          ws.send(JSON.stringify({ t: 'd', d: { r, b: { s: 'ok', d: {} } } }));
          return;
        }
        if (a === 'g') {
          ws.send(JSON.stringify({ t: 'd', d: { r, b: { s: 'ok', d: { fetched: 42 } } } }));
          return;
        }
        ws.send(JSON.stringify({ t: 'd', d: { r, b: { s: 'ok', d: {} } } }));
      },
    },
  });

  if (typeof server.port !== 'number') {
    void server.stop(true);
    throw new Error('Expected loopback WebSocket server to bind a numeric port');
  }
  serverPort = server.port;

  const app = appMod.initializeApp({ projectId: 'demo-socket-drop-fates' }, appName);
  const db = dbMod.getDatabase(app);
  let unsubWatched: (() => void) | null = null;

  try {
    dbMod.connectDatabaseEmulator(db, '127.0.0.1', serverPort);

    let initialWatchedDelivered = false;
    unsubWatched = dbMod.onValue(dbMod.ref(db, 'watched/node'), () => {
      initialWatchedDelivered = true;
    });
    await waitUntil(() => initialWatchedDelivered, 'initial watched/node value');

    holdDataFrames = true;
    holdReconnectHandshake = true;

    let setResolved = false;
    const setPromise = dbMod.set(dbMod.ref(db, 'inflight/set'), { v: 1 }).then(() => {
      setResolved = true;
    });

    let updateResolved = false;
    const updatePromise = dbMod.update(dbMod.ref(db, 'inflight/update'), { u: 2 }).then(() => {
      updateResolved = true;
    });

    let removeResolved = false;
    const removePromise = dbMod.remove(dbMod.ref(db, 'inflight/remove')).then(() => {
      removeResolved = true;
    });

    let setPriorityResolved = false;
    const setPriorityPromise = dbMod.setPriority(dbMod.ref(db, 'inflight/prio'), 5).then(() => {
      setPriorityResolved = true;
    });

    let setWithPriorityResolved = false;
    const setWithPriorityPromise = dbMod
      .setWithPriority(dbMod.ref(db, 'inflight/withPrio'), 'val', 9)
      .then(() => {
        setWithPriorityResolved = true;
      });

    const pushedRef = dbMod.push(dbMod.ref(db, 'inflight/push'), { item: true });
    let mintedPushKey = '';
    if (typeof pushedRef.key === 'string') {
      mintedPushKey = pushedRef.key;
    }
    let pushResolved = false;
    const pushPromise = pushedRef.then(() => {
      pushResolved = true;
    });

    let getSettled = false;
    let getResolvedValue: unknown = null;
    const getPromise = dbMod.get(dbMod.ref(db, 'inflight/get')).then((snap) => {
      getSettled = true;
      getResolvedValue = snap.val();
    });

    let onDiscSetSettled = false;
    void dbMod
      .onDisconnect(dbMod.ref(db, 'inflight/onDiscSet'))
      .set('bye')
      .then(
        () => {
          onDiscSetSettled = true;
        },
        () => {
          onDiscSetSettled = true;
        },
      );

    let onDiscWithPrioSettled = false;
    void dbMod
      .onDisconnect(dbMod.ref(db, 'inflight/onDiscWithPrio'))
      .setWithPriority('bye-prio', 3)
      .then(
        () => {
          onDiscWithPrioSettled = true;
        },
        () => {
          onDiscWithPrioSettled = true;
        },
      );

    let onDiscUpdateSettled = false;
    void dbMod
      .onDisconnect(dbMod.ref(db, 'inflight/onDiscUpdate'))
      .update({ clean: true })
      .then(
        () => {
          onDiscUpdateSettled = true;
        },
        () => {
          onDiscUpdateSettled = true;
        },
      );

    let onDiscRemoveSettled = false;
    void dbMod
      .onDisconnect(dbMod.ref(db, 'inflight/onDiscRemove'))
      .remove()
      .then(
        () => {
          onDiscRemoveSettled = true;
        },
        () => {
          onDiscRemoveSettled = true;
        },
      );

    let onDiscCancelSettled = false;
    void dbMod
      .onDisconnect(dbMod.ref(db, 'inflight/onDiscCancel'))
      .cancel()
      .then(
        () => {
          onDiscCancelSettled = true;
        },
        () => {
          onDiscCancelSettled = true;
        },
      );

    let txSettled = false;
    let txOutcome: 'resolved' | 'rejected' = 'resolved';
    let txErrorName: string | null = null;
    let txErrorMessage: string | null = null;
    let txHasCode = false;
    const txPromise = dbMod
      .runTransaction(dbMod.ref(db, 'tx/item'), (current) => {
        let base = 0;
        if (typeof current === 'number') {
          base = current;
        }
        return base + 1;
      })
      .then(
        () => {
          txSettled = true;
          txOutcome = 'resolved';
        },
        (err: unknown) => {
          txSettled = true;
          txOutcome = 'rejected';
          if (err instanceof Error) {
            txErrorName = err.name;
            txErrorMessage = err.message;
          } else {
            txErrorName = typeof err;
            txErrorMessage = String(err);
          }
          const maybeCoded = err as { code?: unknown };
          txHasCode = Boolean(maybeCoded && maybeCoded.code !== undefined);
        },
      );

    await waitUntil(
      () => frames.some((f) => f.conn === 1 && f.a === 'p' && f.conditionalHash),
      'in-flight conditional transaction put on connection 1',
    );

    const conn1Frames = frames.filter((f) => f.conn === 1);
    let maxConn1RequestId = 0;
    for (const frame of conn1Frames) {
      if (frame.r > maxConn1RequestId) {
        maxConn1RequestId = frame.r;
      }
    }
    const conn1SetFrame = conn1Frames.find((f) => f.p === '/inflight/set');
    const conn1GetFrame = conn1Frames.find((f) => f.p === '/inflight/get');

    const firstSocket = sockets.get(1);
    if (!firstSocket || !conn1SetFrame || !conn1GetFrame) {
      throw new Error('Missing expected connection 1 socket or in-flight set/get frames');
    }

    firstSocket.close();
    await txPromise;
    const settledBeforeReconnectHandshake = txSettled;

    let queuedWhileDisconnectedOnDisconnectResolved = false;
    const queuedOnDiscPromise = dbMod
      .onDisconnect(dbMod.ref(db, 'queued/onDiscWhileDown'))
      .set('later')
      .then(() => {
        queuedWhileDisconnectedOnDisconnectResolved = true;
      });

    let queuedWhileDisconnectedSetResolved = false;
    const queuedSetPromise = dbMod
      .set(dbMod.ref(db, 'queued/setWhileDown'), { after: true })
      .then(() => {
        queuedWhileDisconnectedSetResolved = true;
      });

    await waitUntil(() => pendingHandshakeConn !== null, 'reconnect socket upgrade');
    const reconnectConn = pendingHandshakeConn;
    if (reconnectConn === null) {
      throw new Error('Expected pending reconnect connection');
    }
    const secondSocket = sockets.get(reconnectConn);
    if (!secondSocket) {
      throw new Error('Missing reconnect socket handle');
    }

    holdReconnectHandshake = false;
    sendHandshake(secondSocket, serverPort, reconnectConn);

    await waitUntil(
      () => frames.filter((f) => f.conn === reconnectConn).length >= 10,
      'restored frames on reconnect socket',
    );

    const conn2Frames = frames.filter((f) => f.conn === reconnectConn);

    secondSocket.send(
      JSON.stringify({ t: 'd', d: { r: conn1SetFrame.r, b: { s: 'ok', d: {} } } }),
    );
    secondSocket.send(
      JSON.stringify({ t: 'd', d: { r: conn1GetFrame.r, b: { s: 'ok', d: { stale: true } } } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    const staleWriteReplyToOldRequestIdIgnored = !setResolved;
    const staleGetReplyToOldRequestIdIgnored = !getSettled;

    holdDataFrames = false;
    for (const frame of conn2Frames) {
      if (frame.a === 'q') {
        secondSocket.send(
          JSON.stringify({ t: 'd', d: { a: 'd', b: { p: frame.p, d: { seeded: true } } } }),
        );
        secondSocket.send(JSON.stringify({ t: 'd', d: { r: frame.r, b: { s: 'ok', d: {} } } }));
      } else if (frame.a === 'g') {
        secondSocket.send(
          JSON.stringify({ t: 'd', d: { r: frame.r, b: { s: 'ok', d: { fetched: 42 } } } }),
        );
      } else {
        secondSocket.send(JSON.stringify({ t: 'd', d: { r: frame.r, b: { s: 'ok', d: {} } } }));
      }
    }

    await Promise.all([
      setPromise,
      updatePromise,
      removePromise,
      setPriorityPromise,
      setWithPriorityPromise,
      pushPromise,
      getPromise,
      queuedOnDiscPromise,
      queuedSetPromise,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const sentBeforeDrop: CapturedWireFrameShape[] = conn1Frames.map((frame) => ({
      action: frame.a,
      pathPattern: scrubPushKeyInPath(frame.p, mintedPushKey),
      conditionalHash: frame.conditionalHash,
    }));

    const restoredOnReconnect: CapturedRestoredWireFrameShape[] = conn2Frames.map((frame) => ({
      action: frame.a,
      pathPattern: scrubPushKeyInPath(frame.p, mintedPushKey),
      conditionalHash: frame.conditionalHash,
      newRequestIdGreaterThanMaxBeforeDrop: frame.r > maxConn1RequestId,
    }));

    const conn2Paths = new Set(conn2Frames.map((frame) => frame.p));
    const resentIdenticalKey =
      mintedPushKey.length > 0 && conn2Paths.has(`/inflight/push/${mintedPushKey}`);

    return {
      combinedRestoreWave: {
        sentBeforeDrop,
        restoredOnReconnect,
        pushKeyStability: {
          keyLength: mintedPushKey.length,
          matchesPushCharset: PUSH_KEY_CHARSET_RE.test(mintedPushKey),
          resentIdenticalKey,
        },
        staleWriteReplyToOldRequestIdIgnored,
        staleGetReplyToOldRequestIdIgnored,
        settledAfterReconnectReplies: {
          setResolved,
          updateResolved,
          removeResolved,
          setPriorityResolved,
          setWithPriorityResolved,
          pushResolved,
          getResolvedValue,
          queuedWhileDisconnectedSetResolved,
          queuedWhileDisconnectedOnDisconnectResolved,
        },
        inFlightOnDisconnectFates: {
          setResent: conn2Paths.has('/inflight/onDiscSet'),
          setSettled: onDiscSetSettled,
          setWithPriorityResent: conn2Paths.has('/inflight/onDiscWithPrio'),
          setWithPrioritySettled: onDiscWithPrioSettled,
          updateResent: conn2Paths.has('/inflight/onDiscUpdate'),
          updateSettled: onDiscUpdateSettled,
          removeResent: conn2Paths.has('/inflight/onDiscRemove'),
          removeSettled: onDiscRemoveSettled,
          cancelResent: conn2Paths.has('/inflight/onDiscCancel'),
          cancelSettled: onDiscCancelSettled,
        },
        inFlightTransactionFate: {
          commitResent: conn2Paths.has('/tx/item'),
          settledBeforeReconnectHandshake,
          outcome: txOutcome,
          errorName: txErrorName,
          errorMessage: txErrorMessage,
          hasCode: txHasCode,
        },
      },
    };
  } finally {
    if (unsubWatched) {
      unsubWatched();
    }
    dbMod.goOffline(db);
    await appMod.deleteApp(app).catch(() => undefined);
    void server.stop(true);
  }
}

export const probe: Probe = {
  rig: 'sdk-probes',
  requires: [],
  matrixRow: 'rtdb-modular#HD1, rtdb-modular#HD2',
  rowIds: ['rtdb-modular#HD1', 'rtdb-modular#HD2'],
  description:
    'Offline firebase/database WebSocket drop-fate contract over loopback RTDB v5 wire protocol: observes restoreState resend ordering (listens, in-flight writes with preserved push key, post-drop writes, queued onDisconnects, in-flight gets), fresh request IDs with stale old-ID replies ignored, unsettled non-resent in-flight onDisconnect calls, and immediate codeless Error("disconnect") transaction rejection.',
  async observe() {
    const result = await observeSocketDropInFlightFates();
    return { ...result };
  },
};
