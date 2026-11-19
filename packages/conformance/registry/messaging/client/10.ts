import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["MessagePayload"],
  flipped: 'type-backed',
  exceptionReason:
    'Type-only shape with no runtime carrier: the sandbox broker delivers only data/from/messageId(+notification) and never carries `fcmOptions` on a delivered payload (capture-faithful, the same reason `collapseKey` is omitted). The receive-plane conformance suite has nothing to drive, so the FcmOptions shape is closed structurally by the tier-2 assignability census (resolved decision #5), not a runtime replay. Downgraded from unit-backed under #440 rather than keep a vacuous `toBeDefined()` witness; the residual unobserved risk is retained.',
  api: 'interface FcmOptions { link?; analyticsLabel? }',
  behavior: 'WebpushFcmOptions-style options carried on a client `MessagePayload` (`link`, `analyticsLabel`).',
  evidence: 'Upstream typings (`@firebase/messaging` 0.12.26 `public-types`); no observation yet — type-only shape closed by the assignability census (resolved decision #5).',
});
