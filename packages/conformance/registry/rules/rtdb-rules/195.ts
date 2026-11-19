import { row } from './section.ts';

export default row({
  order: 520,
  featureKeys: [],
  behavior: "The rules tool factories (`createFirestoreRulesTools`, `createFirestoreSimulatorTools`, `createFirestoreRulesStdlibTools`) return handlers typed by Pyric's own `ToolHandler`, `ToolResult` and `ToolContext` from `pyric/sandbox/internal`; an agent tool registry accepts and dispatches them without casts, and neither `pyric` nor `@pyric/cli` depends on an agent runtime",
  status: "conforms",
  evidence: "`unit:rules-tools/tools.test.ts` registers every rules tool in the agent runtime's registry and dispatches calls through it. `unit:studio/ai/pyric-tool-types.test.ts` asserts at compile time that Pyric's handler and result types are assignable to the agent runtime's, and that the agent's context is assignable to Pyric's, then registers and dispatches the standard library tools. The packaging gate's declaration check fails when a published `.d.ts` in `pyric` or `@pyric/cli` imports a package missing from that package's `dependencies` or `peerDependencies`. Tool handler types are Pyric tooling: production has no tool surface, so there is no production observation to replay.",
  automation: "sandbox-only",
  queryable: false,
  exceptionReason: "agent tool tooling; production exposes no tool handler surface",
  conformanceTests: [
    "packages/pyric/test/rules-tools/tools.test.ts",
    "packages/studio/src/ai/pyric-tool-types.test.ts",
  ],
});
