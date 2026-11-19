import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "`ref(storage)` returns the root ref -- `fullPath === ''`, `name === ''`, `parent === null`, `root.fullPath === ''` (`root !== self`, fresh value object)",
  evidence: "Production observation `client-storage-ref-root-and-segments` (firebase 12.19.0) records `bareRoot` (`fullPath: ''`, `name: ''`, `parentFullPath: null`, `rootFullPath: ''`, `rootStrictEqualSelf: false`, `rootToStringMatchesSelf: true`). Replayed across `pyric/storage`, the SharedWorker served entry, and the Node-hosted client.",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["client-storage-ref-root-and-segments"],
});
