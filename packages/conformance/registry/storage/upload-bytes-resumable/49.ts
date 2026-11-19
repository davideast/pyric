import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "`task.pause()` flips `state` to `'paused'`; `task.resume()` continues",
  evidence: "`oracle:storage-uploadbytesresumable-progress-and-controls` (`pauseReturnedTrue: true`, `sawPausedSnapshot: true`, `pauseWhilePausedReturnedFalse: true`, `resumeReturnedTrue: true`, `finalSnapshotState: 'success'`) + `unit:resumable-upload.test.ts`, replayed across all three planes.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
});
