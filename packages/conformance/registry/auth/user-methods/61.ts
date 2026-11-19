import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: ["User"],
  api: "User` methods",
  behavior: "`user.reload()` / `user.delete()` / `user.toJSON()` / `user.refreshToken` / `user.tenantId`",
  status: "unsupported",
  evidence: "not modeled by the sandbox; retained as an explicit unsupported behavior row rather than synthesized (AUTH-GAP)",
  automation: "unsupported",
  exceptionReason: "unsupported / intentionally out of scope",
});
