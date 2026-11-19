import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["setLogLevel"],
  api: "setLogLevel",
  behavior: "Accepted no-op. The sandbox has no modular-SDK-style logger to wire a level into. It uses host-level `console` logging directly, gated by `pyric sandbox`'s own flags, not this call",
  status: "diverged-documented",
  statusNote: "accepted no-op; no sandbox logger wired",
});
