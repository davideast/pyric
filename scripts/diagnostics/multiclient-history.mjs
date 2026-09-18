/** Exercise the count boundary with small events after the timed write workload. */
export async function verifyHistoryCountBoundary(page, WebSocket, url) {
  await page.evaluate(async () => {
    const sdk = await import('firebase/firestore');
    const db = sdk.getFirestore();
    for (let batch = 0; batch < 70; batch++) {
      await Promise.all(Array.from({ length: 50 }, async (_, index) => {
        const initial = Promise.withResolvers();
        const target = sdk.doc(db, 'history-probe', `${batch}:${index}`);
        const stop = sdk.onSnapshot(target, () => initial.resolve(), initial.reject);
        const timeout = setTimeout(() => initial.reject(new Error('History probe listener timed out')), 3000);
        try { await initial.promise; }
        finally { clearTimeout(timeout); stop(); }
      }));
    }
    // Flush ordered unsubscribe messages before taking the history snapshot.
    await sdk.getDoc(sdk.doc(db, 'acceptance', '0'));
  });
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/__pyric/sandbox`);
  const history = Promise.withResolvers();
  const timeout = setTimeout(() => history.reject(new Error('History probe did not receive its snapshot')), 10000);
  socket.on('error', history.reject);
  socket.once('open', () => socket.send(JSON.stringify({ type: 'attach', protocol: 1, transport: 'worker-port' })));
  socket.on('message', data => {
    const frame = JSON.parse(data.toString());
    const attached = frame.type === 'attach-ack';
    if (attached) socket.send(JSON.stringify({ type: 'worker-message', message: { t: 'sub', subId: 'count-probe', target: 'events' } }));
    const hasEvents = frame.type === 'worker-message-result' && frame.message.t === 'event';
    if (hasEvents) history.resolve(frame.message.events);
  });
  try {
    const events = await history.promise;
    const bytes = Buffer.byteLength(JSON.stringify(events));
    const countReached = events.length === 10001;
    const withinByteLimit = bytes <= 8 * 1024 * 1024;
    const hasGap = events[0]?.kind === 'observation_gap' && events[0].reason === 'history-limit';
    return { count: events.length, bytes, hasGap, passed: countReached && withinByteLimit && hasGap };
  } finally {
    clearTimeout(timeout);
    socket.terminate();
  }
}
