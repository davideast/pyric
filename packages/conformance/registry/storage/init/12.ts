import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: ["getStorage"],
  behavior: "The served `firebase/storage` entry accepts bare `getStorage()` and returns the page's shared sandbox handle",
  status: "conforms",
  evidence: "The canonical served entry supplies the page sandbox when the app argument is omitted; the entry-path and bundler suites execute the public package shape.",
  conformanceTests: ["packages/conformance/entry-path/storage.ts","packages/cli/test/serve/bundler.test.ts"],
  exceptionReason: "package-resolution behavior — production package selection is outside the mirror",
});
