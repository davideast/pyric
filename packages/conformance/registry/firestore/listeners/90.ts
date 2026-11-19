import { row } from './section.ts';

export default row({
  order: 130,
  behavior: "Preview tree mounts the user's component exactly once per session load — no observer subscriptions leak across parallel `AppPreview` instances. Root cause: `PlaygroundPage` rendered both `WorkspacePanel`'s and the mobile `AppPanel`'s `AppPreview` unconditionally (the latter `md:hidden` on desktop but still mounted), producing two live preview trees subscribing in parallel. Fixed by gating `AppPanel` on `useIsMobile() && mobileTab === 'app'`.",
  evidence: "`playground:preview-single-mount`",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "playground-only",
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
