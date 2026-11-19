import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Exported by `firebase/storage`; returns an `UploadTask` with `pause()` / `resume()` / `cancel()`",
  evidence: "`oracle:storage-uploadbytesresumable-progress-and-controls` (`hasPauseMethod: true`, `hasResumeMethod: true`, `hasCancelMethod: true`, `hasOnMethod: true`, `unsubscribeIsFunction: true`) + `unit:resumable-upload.test.ts`, replayed across all three planes.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 2 specific value(s)"],
});
