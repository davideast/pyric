import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "`getDatabase()` (no argument) — wrapped in the playground preview to supply the sandbox; a raw mirror call rejects with package-resolution guidance",
  status: "conforms",
  statusNote: "(wrap, fixture passing)",
  evidence: "Phase 3 Tier 5: virtualized in the playground preview scope. Wired at `packages/playground/src/components/AppPreview.tsx` (slot install with bare-call wrap), `packages/playground/src/lib/preview/virtual-imports-plugin.ts` (alias map), and `packages/playground/src/lib/preview/preview-scope.ts` (type-level slot). Mirrors the `getAuth` / `getFirestore` wrap pattern. Demo fixture: `packages/playground/scripts/fixtures/rtdb-set-get-roundtrip.tsx` (bare `getDatabase()` + `set`/`get`/`remove` round-trip with anonymous sign-in) passes end-to-end through the `bun run debug:fixtures` Playwright suite.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  automation: "playground-only",
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
  aliases: ["rtdb#97"],
});
