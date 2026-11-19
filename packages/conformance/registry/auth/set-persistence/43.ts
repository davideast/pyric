import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Actually changes where the auth state is persisted",
  status: "diverged-documented",
  evidence: "divergence: sandbox is a no-op. Prod respects the marker.",
  automation: "unverified",
});
