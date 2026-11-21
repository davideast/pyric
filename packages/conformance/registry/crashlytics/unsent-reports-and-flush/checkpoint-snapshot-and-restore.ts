import { row } from './section.ts';

export default row({
  order: 30,
  api: "CrashlyticsBroker.snapshot() / restore(raw) / captureFullState & applyFullState",
  behavior: "Registers CrashlyticsBroker as a persistable sandbox service so per-app reports, unsent queues, logs, customKeys, and userId round-trip across captureFullState and applyFullState checkpoints.",
  featureKeys: ["CrashlyticsSnapshot", "getCrashlyticsBroker"],
  statusNote: "Verified in in-process sandbox unit suite; not yet exercised across a live HostedRuntime checkpoint restore.",
  evidence: "Verified in `packages/pyric/test/crashlytics/crashlytics.test.ts` (`executes all 10 shared CrashlyticsBroker operations including disabled collection unsent queues and full-state reset`).",
  tests: [
    "packages/pyric/test/crashlytics/crashlytics.test.ts",
  ],
});
