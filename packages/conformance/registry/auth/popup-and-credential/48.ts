import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "Opens a popup window in prod",
  status: "diverged-documented",
  evidence: "divergence: sandbox skips the popup; mock pre-stage replaces the popup result",
  automation: "unverified",
});
