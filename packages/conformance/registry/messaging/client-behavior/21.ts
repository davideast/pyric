import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["getToken"],
  api: 'Registration-token inactivity expiry (server-side staleness window)',
  behavior:
    'FCM treats a registration token that has gone unused for an extended period (Google documents roughly 270 days of app-instance inactivity) as stale and drops it from delivery targeting, independent of any explicit `deleteToken`. The expiry clock is Google server-side inactivity accounting, and the recommended mitigation is periodic token refresh. Stated from FCM best-practices documentation; the sandbox has no server-side inactivity clock to model.',
  evidence:
    'Upstream documentation (FCM registration-token best practices); no observation. This time-based server-side behavior is out of sandbox scope (see the row disposition); the explicit-deletion path to a dead token is already tracked by messaging#3.',
  riskReasons: [
    'Server-side inactivity-based token expiry (the ~270-day staleness window) is unevidenced and cannot be modelled by the sandbox; no observation and no feasible long-horizon probe.',
  ],
  unsupportedReason:
    'Time-based server-side inactivity expiry (the ~270-day staleness window Google enforces) is accounted on Google infrastructure over wall-clock months; the sandbox broker has no inactivity clock and will never model it, and aging a real token for months to capture the transition is neither a feasible nor a repeatable probe. The explicit-deletion path to a dead token is tracked by messaging#3.',
});
