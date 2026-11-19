import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`ref(storage, 'sessions/s1.json')` populates `fullPath`, `name` (last segment), `parent` (path without last segment)",
  evidence: "Production observation `client-storage-ref-root-and-segments` (firebase 12.19.0) records `singleSegment`, `nestedSegments` (`sessions/s1.json` -> `name: 's1.json'`, `parentFullPath: 'sessions'`), and `deepSegments`. Replayed across all three planes.",
  oracleObservations: ["client-storage-ref-root-and-segments"],
});
