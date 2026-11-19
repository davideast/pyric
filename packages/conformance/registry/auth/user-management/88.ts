import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["useDeviceLanguage"],
  api: "useDeviceLanguage(auth)",
  behavior: "Accepted no-op — the sandbox has no device locale to read, so there is no language to set; accepted so init code that calls it compiles + runs",
  status: "diverged-documented",
  statusNote: "no device locale in the sandbox",
  evidence: "`unit:fruit-aliases.test.ts` — resolves/returns without error",
  conformanceTests: ["packages/pyric/test/auth/fruit-aliases.test.ts"],
});
