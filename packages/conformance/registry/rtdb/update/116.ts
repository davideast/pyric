import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "`update(ref, {a: 1, b: 2})` merges top-level keys at the ref; unspecified keys preserved (in contrast to `set`'s replacement). A child value's `.priority` becomes that child's priority, for rules and in storage. `update(ref, {})` and `onDisconnect(ref).update({})` resolve without evaluating rules and write or queue nothing",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-update-merges-keys.json` — after `set({a:1,b:2})` then `update({a:10})`, observed `final: {a:10, b:2}`. The empty update follows the production SDK source (`@firebase/database` 1.1.3, `repoUpdate` and `repoOnDisconnectUpdate`): with no children to merge it logs \"called with empty data\" and completes with `ok` without sending anything, so no rule runs. `unit:rules/rtdb/rtdb-rules-audit-regressions.test.ts` resolves both under a denying `.write` with nothing written and an earlier queued disconnect write kept, and `unit:cli/serve/worker/rtdb-empty-update.test.ts` asserts the same through the SharedWorker host. The child priority follows the SDK's `nodeFromJSON`, which reads a child value's `.priority`; the same test file asserts it reaches `newData.getPriority()` and the stored node.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-update-merges-keys"],
  conformanceTests: ["packages/pyric/test/rules/rtdb/rtdb-rules-audit-regressions.test.ts", "packages/cli/test/serve/worker/rtdb-empty-update.test.ts"],
  aliases: ["rtdb#116"],
});
