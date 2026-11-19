import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["getStorage","getStorageSandbox"],
  behavior: "`options.rules` parsed eagerly — malformed rules throw `SyntaxError` at config time",
  status: "conforms",
  evidence: "`unit:storage/sandbox/rules.test.ts` (parse errors propagate from `parseStorageRules`)",
  conformanceTests: ["packages/rules/test/storage/sandbox/rules.test.ts"],
});
