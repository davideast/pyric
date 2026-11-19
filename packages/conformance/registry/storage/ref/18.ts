import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "`ref(parent, child)` joins relative to parent's `fullPath` (including empty/slash-only child producing `<parent>/` with `name: '<last>/'`)",
  evidence: "Production observation `client-storage-ref-hierarchy-and-traversal` (firebase 12.19.0) records `childFromRoot`, `childFromFolder`, `slashyChildJoin`, and `emptyChildJoin` / `slashOnlyChildJoin` (`users/u1/` with `name: 'u1/'`, `parentFullPath: 'users/u1'`). Replayed across all three planes.",
  oracleObservations: ["client-storage-ref-hierarchy-and-traversal"],
});
