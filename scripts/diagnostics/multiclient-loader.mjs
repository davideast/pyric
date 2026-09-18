/** Read-only measurement hooks; no source or built artifact is modified on disk. */
const hooks = new Map([
  ['/sandbox/internal/event-history.js', [
    ['this.limits = limits;', 'this.limits = limits; globalThis.__multiClient.histories.push(new WeakRef(this));'],
  ]],
  ['/bridge/operation-budget.js', [
    ['let pendingOperations = 0;', 'const measurementId = globalThis.__multiClient.nextBudget++; let pendingOperations = 0;'],
    ['pendingOperationBytes += operationBytes;', 'pendingOperationBytes += operationBytes; globalThis.__multiClient.budget(measurementId, pendingOperations, pendingOperationBytes);'],
    ['pendingOperationBytes -= operationBytes;', 'pendingOperationBytes -= operationBytes; globalThis.__multiClient.budget(measurementId, pendingOperations, pendingOperationBytes);'],
  ]],
  ['/serve/hosted/runtime.js', [
    ['const hostedFetch = Object.assign', 'globalThis.__multiClient.context = new WeakRef(ctx); globalThis.__multiClient.history = new WeakRef(persistence.history);\n    const hostedFetch = Object.assign'],
  ]],
  ['/serve/worker/serve-init.js', [
    ['const unsub = ctx.sandbox.onEvent(() => {', 'const unsub = ctx.sandbox.onEvent(() => { globalThis.__multiClient.captureDirty();'],
  ]],
  ['/serve/capture-store.js', [
    ['writeFileSync(path, fixtureJson);', 'writeFileSync(path, fixtureJson); globalThis.__multiClient.captureWritten(Buffer.byteLength(fixtureJson));'],
  ]],
  ['/bridge/server/socket-message.js', [
    ['const exceedsBacklog = socket.bufferedAmount', 'globalThis.__multiClient.socketBytes = Math.max(globalThis.__multiClient.socketBytes, socket.bufferedAmount);\n    const exceedsBacklog = socket.bufferedAmount'],
  ]],
]);

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const match = [...hooks].find(([suffix]) => url.endsWith(suffix));
  if (!match) return result;
  let source = String(result.source);
  for (const [before, after] of match[1]) {
    const changedAnchor = source.split(before).length !== 2;
    if (changedAnchor) throw new Error(`Measurement anchor changed: ${url}: ${before}`);
    source = source.replace(before, after);
  }
  return { ...result, source };
}

// Detailed probes are diagnostic-only. Durations overlap and must not be summed.
if (process.env.PYRIC_MULTICLIENT_PROFILE === '1') {
  hooks.get('/serve/hosted/runtime.js').push(
    ['const flushed = persistenceWork.then(persistState);', `const persistenceQueuedAt = performance.now();
        const flushed = persistenceWork.then(() => {
          globalThis.__multiClient.measure('persistenceQueueMs', performance.now() - persistenceQueuedAt);
          return persistState();
        });`],
    ['owned.pending = owned.pending.then(() => {', `const operationQueuedAt = performance.now();
        owned.pending = owned.pending.then(() => {
          globalThis.__multiClient.measure('operationQueueMs', performance.now() - operationQueuedAt);`],
  );
  hooks.set('/sandbox/persistence/changed-buckets.js', [
    ['const documents = this.snapshot();', `const snapshotStarted = performance.now();
        const documents = this.snapshot();
        globalThis.__multiClient.measure('snapshotMs', performance.now() - snapshotStarted);`],
    ['const captured = this.dirty;', 'const serializationStarted = performance.now(); const captured = this.dirty;'],
    ['return { records, removed, retry };', `globalThis.__multiClient.measure('serializationMs', performance.now() - serializationStarted);
        return { records, removed, retry };`],
  ]);
  hooks.set('/sandbox/persistence/controller.js', [
    ['const changed = new Map();', 'const hashingStarted = performance.now(); const changed = new Map();'],
    ['const applyChanges = backend.applyChanges;', `globalThis.__multiClient.measure('hashingMs', performance.now() - hashingStarted);
        globalThis.__multiClient.measure('recordsExamined', records.size);
        globalThis.__multiClient.measure('recordsChanged', changed.size);
        const applyChanges = backend.applyChanges;`],
  ]);
  hooks.set('/serve/hosted/persistence/sqlite.js', [
    ["const isRead = mode === 'read';", "const transactionStarted = performance.now(); const isRead = mode === 'read';"],
    ["connection.exec('COMMIT');", "connection.exec('COMMIT'); globalThis.__multiClient.measure(isRead ? 'readTransactionMs' : 'writeTransactionMs', performance.now() - transactionStarted);"],
  ]);
}
