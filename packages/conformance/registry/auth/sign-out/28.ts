import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Clears the active session's persistence in prod; sandbox has no persistence",
  status: "diverged-documented",
  evidence: "divergence: same memory-only constraint as the anonymous persistence row",
  automation: "unverified",
});
