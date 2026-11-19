import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["persistentLocalCache","memoryLocalCache","persistentSingleTabManager","persistentMultipleTabManager","memoryEagerGarbageCollector","memoryLruGarbageCollector"],
  api: "persistentLocalCache / memoryLocalCache / persistentSingleTabManager / persistentMultipleTabManager / memoryEagerGarbageCollector / memoryLruGarbageCollector",
  behavior: "Config token accepted, inert — each returns a small tagged object so identity/usage doesn't crash. Persistence is the sandbox default; there is no cache tier left to configure",
  status: "diverged-documented",
  statusNote: "inert config tokens; no cache tier to configure",
});
