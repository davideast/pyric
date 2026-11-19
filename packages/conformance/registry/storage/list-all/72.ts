import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "`items` sorted by path (IDB key order, lexicographic)",
  evidence: "`oracle:storage-listall-lexicographic-order` (`observedItemNames: ['10.bin', '2.bin', 'B.bin', 'a.bin', 'z.bin']`), replayed across `oracle-conformance.test.ts`, `storage-listall-parity.test.ts`, and `hosted-sqlite.test.ts`",
  oracleObservations: ["storage-listall-lexicographic-order"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-listall-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts", "packages/pyric/test/storage/list.test.ts"],
});
