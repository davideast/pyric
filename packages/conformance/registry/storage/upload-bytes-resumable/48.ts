import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`task.on('state_changed', next, error, complete)` fires `next` with `{bytesTransferred, totalBytes, state}` snapshots",
  evidence: "`oracle:storage-uploadbytesresumable-progress-and-controls` (`sawRunningSnapshot: true`, `bytesMonotonicNonDecreasing: true`, `allTotalBytesMatchPayload: true`, `completeCallbackFiredOnce: true`, `finalSnapshotState: 'success'`) + `unit:resumable-upload.test.ts`, replayed across all three planes.",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
});
