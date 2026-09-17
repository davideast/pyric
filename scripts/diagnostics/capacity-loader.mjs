/** Diagnostic-only transforms: never writes to source or built artifacts. */
const hooks = new Map([
  ['/serve/hosted/runtime.js', [
    ['const message = { ...incoming,', 'const capacityQueuedAt = performance.now();\n        globalThis.__capacity.pending++;\n        const message = { ...incoming,'],
    ['owned.pending = owned.pending.then(() => {\n            const changesDurableState', 'owned.pending = owned.pending.then(async () => {\n            globalThis.__capacity.time("queue", capacityQueuedAt);\n            const capacityStarted = performance.now();\n            const changesDurableState'],
    ['return handleMessage(ctx, owned.port, message);', 'try { return await handleMessage(ctx, owned.port, message); } finally { globalThis.__capacity.time("execute", capacityStarted); }'],
    ['releaseOperation?.();', 'globalThis.__capacity.pending--;\n            releaseOperation?.();'],
  ]],
  ['/sandbox/persistence/controller.js', [
    ['const snap = sandbox.snapshot();', 'const capacityStarted = performance.now();\n        const snap = sandbox.snapshot();'],
    ['const applyChanges = backend.applyChanges;', 'globalThis.__capacity.time("snapshotSerializeHash", capacityStarted);\n        globalThis.__capacity.count("scannedRecords", records.size);\n        globalThis.__capacity.count("changedRecords", changed.size);\n        const applyChanges = backend.applyChanges;'],
  ]],
  ['/hosted/persistence/commits.js', [
    ['const duration = performance.now() - started;', 'globalThis.__capacity.time("sqliteTransaction", started);\n            const duration = performance.now() - started;'],
  ]],
  ['/firestore/sandbox/event-log.js', [
    ['this.clock = clock;', 'this.clock = clock;\n        globalThis.__capacity.owners.push({ kind: "undo", ref: new WeakRef(this) });'],
  ]],
  ['/sandbox/internal/event-history.js', [
    ['this.limits = limits;', 'this.limits = limits;\n        globalThis.__capacity.owners.push({ kind: "observations", ref: new WeakRef(this) });'],
  ]],
]);
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  const match = [...hooks].find(([suffix]) => url.endsWith(suffix));
  if (!match) return result;
  let source = String(result.source);
  for (const [before, after] of match[1]) {
    if (source.split(before).length !== 2) throw new Error(`Capacity probe anchor changed: ${url}: ${before}`);
    source = source.replace(before, after);
  }
  return { ...result, source };
}
