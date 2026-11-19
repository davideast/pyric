import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["goOffline"],
  behavior: "`goOffline(db)` transitions that client's `.info/connected` to `false`, drains its server-armed `onDisconnect` queue once, isolates its local SyncTree overlay and outbound write/transaction/onDisconnect/uncached-`get()` queue from other clients while deferring remote updates, and throws synchronously on a deleted database",
  aliases: ["rtdb#163"],
});
