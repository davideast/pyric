import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Throws `storage/object-not-found` for missing objects",
  status: "conforms",
  evidence: "Production observation `storage-delete-then-get-throws` records `getDownloadURL` throwing `storage/object-not-found` after deletion. The sandbox oracle replay invokes `getDownloadURL` itself and matches that code, and the hosted replay matches it through the web client against the Node host, whose `getDownloadURL` runs over the RPC. The public error-code suite also pins the never-existing-object case.",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/object-not-found`"],
  oracleObservations: ["storage-delete-then-get-throws"],
  conformanceTests: ["packages/pyric/test/storage/error-codes.test.ts","packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts"],
});
