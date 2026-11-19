import { row } from './section.ts';

export default row({
  order: 340,
  featureKeys: ["timestamp.date", "replace", "lower", "toSet", "Map.get", "diff", "exists", "request.resource"],
  behavior: "Runtime operand types for `-`, `*`, `/`, `%`, and unary `-`; user-defined functions shadowing global built-ins and enforcing parameter arity; Java `Matcher` replacement escapes (`\\$`, `$1`) and string/list/map method arity and argument types; `request.resource` omitted on `get`, `list`, and `delete` without a test payload (and populated on `delete` when the Rules Test API case supplies `data`); `timestamp.date(y, m, d)` calendar bounds; runtime string-key enforcement on map literals; and document-level `Path` requirement on `exists()`/`get()`/`existsAfter()`/`getAfter()`",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "NEW ROW, 2026-10-17: `oracle:rules-firestore-simulator-language-semantics` captures 18 production verdicts (4 ALLOW, 14 DENY) across `FS-SIM-2`, `FS-SIM-4`, `FS-SIM-5`, `FS-SIM-6`, `FS-SIM-9`, `FS-SIM-10`, `FS-SIM-11`, and `FS-SIM-12`. Production denies non-numeric arithmetic (`'abc' - 'a'`, `-'5'`), wrong user-function arity, extra arguments to `string.lower()`, `list.toSet()`, `map.get()`, and `map.diff()`, non-map arguments to `map.diff()`, out-of-range calendar dates in `timestamp.date()` (`month: 13`, `Feb 30`), non-string dynamic map literal keys, and string or odd-segment collection-path arguments to `exists()`; allows a user function named `int` shadowing the built-in cast and `string.replace` with `\\$`; and omits `request.resource` on `get` and `delete` without a test payload while honoring a test-supplied `data` payload on `delete`. `unit:rules/oracle-conformance.test.ts` replays all 18 verdicts and `unit:rules/simulator/evaluation-builtins.test.ts` pins the full simulator semantics suite.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts rules-denial behavior across arithmetic, arity, date bounds, map keys, and lookup paths"],
  oracleObservations: ["rules-firestore-simulator-language-semantics"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/evaluation-builtins.test.ts",
    "packages/rules/test/simulator/document-lookups.test.ts",
    "packages/rules/test/simulator/wrappers/latlng.test.ts",
  ],
  constructs: [
    "firestore.operator.sub",
    "firestore.operator.unary-minus",
    "firestore.rule-kind.function",
    "firestore.method.string.replace",
    "firestore.method.string.lower",
    "firestore.method.list.toSet",
    "firestore.method.map.get",
    "firestore.method.map.diff",
    "firestore.binding.request.resource",
    "firestore.binding.request.resource.data",
    "firestore.function.timestamp.date",
    "firestore.function.exists",
  ],
});
