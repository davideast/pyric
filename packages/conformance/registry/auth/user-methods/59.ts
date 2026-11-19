import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`user.metadata.creationTime` / `lastSignInTime`",
  status: "unsupported",
  evidence: "client `User.metadata` not exposed (AUTH-GAP); the admin record carries `createdAt`/`lastLoginAt` (ISO)",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  automation: "unsupported",
  exceptionReason: "unsupported / intentionally out of scope",
});
