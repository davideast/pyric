import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["goOnline"],
  behavior: "`goOnline(db)` transitions `.info/connected` back to `true` without resurrecting drained `onDisconnect` operations, delivers deferred remote updates, flushes queued offline writes, transactions, `onDisconnect` registrations, and uncached `get()` reads in FIFO order, and throws synchronously on a deleted database",
  aliases: ["rtdb#164"],
});
