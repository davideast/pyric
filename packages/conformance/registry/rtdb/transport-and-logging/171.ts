import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["forceLongPolling"],
  behavior: "`forceLongPolling()` — accepted no-op: transport selection is not applicable to the in-process/worker sandbox (it never opens a real socket). Accepted so init code that calls it compiles + runs",
  statusNote: "transport selection not applicable to the in-process/worker sandbox",
  conformanceDisposition: "by-design",
  aliases: ["rtdb#171"],
});
