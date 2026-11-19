import { cddLifecycleTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["getDatabase"],
  api: "getDatabase(app, url) (served in-page fallback)",
  behavior: "The served in-page fallback keeps each URL's data separate and applies each instance the rules `firebase.json` deploys to it. A database opened without a URL is the project's default instance, and rules `firebase.json` deploys to `<projectId>-default-rtdb` or `<projectId>` reach it once the app names its project; a `databaseURL` of `https://<projectId>.firebaseio.com` opens it too, and different rules for both names lock it with an error naming both files. An instance `firebase.json` deploys no rules to is locked, `.read` and `.write` false at the root as production creates a new instance, or open under permissive mode as the default instance is, and its first use logs which access applies and which `database` entry would deploy its rules; a declared instance whose rules file is missing follows the default policy. As the SDK does, a second URL form naming an open instance throws `Database initialized multiple times`, and neither a URL nor a project id throws `Can't determine Firebase Database URL`. A ruleset the load-time check refuses is not installed for its instance, and the other instances keep theirs. Production deploys rules per instance.",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`packages/cli/test/serve/database-rules-deployment.test.ts` deploys two rulesets to two instances and asserts each instance allows and denies its own paths, that replacing one instance's rules leaves the other's in force, that a database opened without a URL gets the default instance's rules, that a refused ruleset names its instance while the other instance loads, and replays oracle `rtdb-modular-multiple-instances` across the served in-page fallback. Oracle `rtdb-modular-multiple-instances` records production enforcing a different ruleset on each of two instances of one project. CDD assertion `rtdb-modular#MI2` pins the sandbox side: `setRules` on one URL's database leaves the other URL's rules unchanged. `packages/cli/test/serve/database-rules-legacy-default-instance.test.ts` asserts an app on `https://<projectId>.firebaseio.com` gets the default rules from each `firebase.json` shape with no locked `<projectId>` instance, and the refusal of different rules for both names.",
  oracleObservations: ["rtdb-modular-multiple-instances"],
  conformanceTests: ["packages/cli/test/serve/database-rules-deployment.test.ts", "packages/cli/test/serve/database-rules-legacy-default-instance.test.ts", ...cddLifecycleTests],
});
