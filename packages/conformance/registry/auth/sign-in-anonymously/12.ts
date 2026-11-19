import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "Anonymous users persist across page reload via configured `Persistence` (prod only — sandbox has no persistence layer)",
  status: "diverged-documented",
  evidence: "divergence: sandbox memory only; within one tab the user persists, across reload they don't",
  automation: "unverified",
});
