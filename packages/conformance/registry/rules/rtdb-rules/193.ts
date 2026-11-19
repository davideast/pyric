import { row } from './section.ts';

export default row({
  order: 220,
  featureKeys: [],
  behavior: "`locateRtdbRule(source, path, kind)` maps a rule node (`.read`, `.write`, `.validate` or `.indexOn` at a rule-tree path) to the line and column of its key in `database.rules.json`, including files with comments, rule strings that span lines, and trailing commas; Studio marks that line for an RTDB denial and `pyric database rules validate` prints it per finding. `locateRtdbTrace(source, trace)` gives each entry of an evaluation trace the line of the rule it evaluated; Studio renders one row per evaluated rule and marks the row's line when it is clicked, and `rules.simulate` with inline database rules returns the trace with those lines",
  status: "conforms",
  evidence: "`unit:rules/rtdb/source-locations.test.ts` pins nested paths, `$wildcard` segments, keys and braces inside comments and strings, block comments across lines, CR and CRLF line endings, rule strings that span lines, trailing commas in objects and arrays, duplicate keys and unparseable text, and refuses a doubled or leading comma; `oracle:rtdb-rules-text-dialect` records production accepting and refusing the same forms. `unit:cli/rules-engines/database-denial.test.ts` asserts the lines of an `explainDenial` draft whose rule string spans lines and whose objects end in commas. `unit:studio/rules-debug.test.ts` runs sandbox RTDB denials against a commented ruleset and asserts the marked line, including a path whose rule text is identical to another's, and the rendered line label. `unit:cli/cli.test.ts` asserts `line` and `column` on a `validate` finding. `unit:rules/rtdb/source-locations.test.ts` also covers the trace lookup, `unit:studio/rules-debug/RtdbTrace.test.tsx` renders a three-rule cascade and asserts each row's line and the marked line after a click, and `unit:cli/rules-engines/database.test.ts` asserts the lines on an inline `rules.simulate` trace. Source positions are Pyric tooling: production returns no rule position, so there is no production observation to replay.",
  automation: "sandbox-only",
  queryable: false,
  exceptionReason: "source-position tooling; production rules results carry no file position",
  conformanceTests: [
    "packages/rules/test/rtdb/source-locations.test.ts",
    "packages/studio/src/features/rules-debug/rules-debug.test.ts",
    "packages/cli/src/cli/cli.test.ts",
    "packages/studio/test/features/rules-debug/RtdbTrace.test.tsx",
    "packages/cli/test/bridge/surface/rules-engines/database.test.ts",
  ],
});
