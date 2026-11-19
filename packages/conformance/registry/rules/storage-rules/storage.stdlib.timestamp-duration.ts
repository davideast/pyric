import { row } from './section.ts';

export default row({
  order: 370,
  featureKeys: ["request.time", "resource.timeCreated", "resource.updated", "timestamp.date", "timestamp.value", "duration.value", "duration.time", "duration.abs"],
  behavior: "`request.time`, `resource.timeCreated`, and `resource.updated` are timestamps; `timestamp.date`/`timestamp.value` build timestamps and `duration.value`/`duration.time`/`duration.abs` build durations. The timestamp accessors `year()`, `month()`, `day()`, `hours()`, `minutes()`, `seconds()`, `nanos()`, `dayOfWeek()`, `dayOfYear()`, `date()`, `time()`, and `toMillis()` read UTC components, where `seconds()` is the seconds of the minute and `toMillis()` is the only epoch value. Timestamp minus timestamp is a duration, timestamp plus or minus duration is a timestamp, values of one type compare with `==` and `<`, and `is timestamp` and `is duration` hold. An int has no timestamp methods, an error that `|| true` absorbs, and comparing a timestamp with an int is an error",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "CONFORMS, 2026-09-24: `oracle:rules-storage-stdlib-timestamp-duration` captures 15 production verdicts for corpus scenario \"stdlib-timestamp-duration\", including the paired seconds-of-minute and epoch-seconds cases and the production diagnostics `Function not found error: Name: [hours].` and `Unsupported operation error. Received: timestamp < int.` `request.time`, the resource time fields, and the `timestamp.*` and `duration.*` constructors are the shared Timestamp and Duration values, which answer their own accessors and operators. `unit:storage/rules-oracle-conformance.test.ts` replays all 15 verdicts; `unit:storage/sandbox/rules-time-methods.test.ts`, `unit:storage/sandbox/rules-operators.test.ts`, and `unit:storage/sandbox/rules-bindings.test.ts` pin the values and error messages.",
  risk: ["specific-value", "rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts 3 specific value(s)", "asserts rules-denial behavior"],
  oracleObservations: ["rules-storage-stdlib-timestamp-duration"],
  conformanceTests: [
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/storage/sandbox/rules-time-methods.test.ts",
    "packages/rules/test/storage/sandbox/rules-operators.test.ts",
    "packages/rules/test/storage/sandbox/rules-bindings.test.ts",
  ],
  constructs: [
    "storage.binding.request.time",
    "storage.binding.resource.timeCreated",
    "storage.binding.resource.updated",
    "storage.function.timestamp.date",
    "storage.function.timestamp.value",
    "storage.function.duration.value",
    "storage.operator.is",
  ],
});
