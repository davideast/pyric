import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Without sandbox package swapping, canonical `firebase/auth` imports remain Firebase and never enter this mirror",
  status: "unverified",
  evidence: "Direct mirror rejection is locked by `unit:package-resolution.test.ts`; an unswapped production-resolution observation is still needed",
  automation: "unverified",
});
