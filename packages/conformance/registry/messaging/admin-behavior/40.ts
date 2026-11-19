import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["send", "sendEach"],
  api: 'FCM send quota and rate-limit throttling',
  behavior:
    'FCM enforces project-level send quotas and per-target rate limits (per-device and per-topic message rates) accounted on Google servers over rolling windows; exceeding them yields quota / rate-limit rejections. The admin error taxonomy names these as `MessagingClientErrorCode.MESSAGE_RATE_EXCEEDED`, `DEVICE_MESSAGE_RATE_EXCEEDED`, and `TOPICS_MESSAGE_RATE_EXCEEDED` (wire `QUOTA_EXCEEDED` / `RESOURCE_EXHAUSTED`, HTTP 429). Stated from FCM quota documentation; the sandbox has no global quota ledger to model.',
  evidence:
    'Upstream documentation (FCM quotas and `MessagingClientErrorCode` rate-limit members, firebase-admin 13.10.0); no observation. This behavior is out of sandbox scope (see the row disposition).',
  riskReasons: [
    'FCM quota / rate-limit throttling and its `MESSAGE_RATE_EXCEEDED` / `DEVICE_MESSAGE_RATE_EXCEEDED` / `TOPICS_MESSAGE_RATE_EXCEEDED` envelopes are unevidenced and unmodellable in the sandbox; no observation and no safe probe.',
  ],
  unsupportedReason:
    'Send quota and rate-limit accounting is enforced on Google infrastructure over rolling per-project and per-target windows; the sandbox broker keeps no global quota ledger and will never model it, and deliberately exhausting production quota to capture the rate-limit envelope is neither a safe nor a repeatable probe.',
});
