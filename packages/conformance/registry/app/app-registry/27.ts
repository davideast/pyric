import { row } from './section.ts';

export default row({
  order: 270,
  featureKeys: ["getAI","deleteApp"],
  section: "`FirebaseApp` deletion lifecycle",
  api: "getAI(app, customEngine); deleteApp(app); retainedModel operation",
  behavior: "Served worker mode rejects page-local custom AnswerEngine objects; a model retained from a deleted app rejects, while an equal-config sibling model remains usable through its own app-scoped worker port",
  status: "unverified",
  evidence: "`packages/cli/test/e2e/app-deletion.pw.ts` observes AI code `unsupported` for a custom engine, then exercises retained and sibling models through canonical served imports after deleting one app; `packages/pyric/src/ai/sandbox-plane.ts` guards every model operation. A credentialed production AI lifecycle capture is still needed",
  risk: ["stateful","structural"],
  riskScore: 4,
  riskReasons: ["asserts deleted-container isolation, worker ownership, and sibling survival"],
  automation: "unverified",
});
