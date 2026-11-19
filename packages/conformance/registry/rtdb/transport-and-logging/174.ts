import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["refFromURL"],
  behavior: "`refFromURL(db, url)` matches Firebase's path parsing, query ignoring, FTP-to-database normalization, fragment rejection and malformed-URL error. As the SDK does, a URL whose host is not the database's host throws `Host name does not match the current database`, unless the database's host is custom (any domain but `firebaseio.com` and `firebaseio-demo.com`). A sandbox database opened without a URL has no host, so its URLs are not checked.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-reference-shape-url` captures accepted FTP/query URLs and rejected fragments, malformed URLs, and host mismatches; `unit:modular/oracle-conformance-reference-writes.test.ts` replays each, and `unit:modular/ref-from-url-host.test.ts` pins the host check for an app's default instance, a named instance and a custom host, from hunt finding RT-12.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-reference-shape-url"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts","packages/pyric/test/database/modular/ref-from-url-host.test.ts"],
  aliases: ["rtdb#174"],
});
