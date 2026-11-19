import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["forceWebSockets"],
  behavior: "`forceWebSockets()` — accepted no-op: transport selection is not applicable to the in-process/worker sandbox (see `forceLongPolling`)",
  statusNote: "transport selection not applicable to the in-process/worker sandbox",
  conformanceDisposition: "by-design",
  aliases: ["rtdb#172"],
});
