import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["setDoc", "getDoc"],
  api: "Writes and reads in flight at a hosted connection drop (web hosted client)",
  behavior: "A Firestore write (`setDoc`, `updateDoc`, `deleteDoc`, a batch `commit`) or read (`getDoc`, `getDocs`) the web hosted client's socket had taken when it dropped fails once with `unavailable` and the message \"The hosted sandbox connection was lost. Requests already sent may have completed; check state before retrying.\" It is not sent again. In production the Firestore Web SDK keeps a write in its mutation queue and sends it again on the next write stream until the backend acknowledges it, and answers a `getDoc` from its local cache, with `fromCache`, or fails it with `unavailable` when the document is not cached.",
  statusNote: "a write in flight fails instead of being sent again; pyric has no local cache to answer a read from",
  evidence: "Production behavior read from `@firebase/firestore` 4.14.1, as recorded in ADR-0019 (\"Reads and writes are treated alike, unlike production\"). `packages/cli/test/serve/worker/hosted-reconnect-hold.test.ts` drops a real loopback socket with `setDoc`, `getDoc` and `batchCommit` in flight and asserts each fails once with that message and reaches the host once. The Realtime Database follows its SDK here instead (row `rtdb-modular#HD1`, #1088).",
  conformanceTests: ["packages/cli/test/serve/worker/hosted-reconnect-hold.test.ts"],
});
