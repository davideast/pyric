/**
 * Permission dial: state machine + confirm-policy mapping (F3).
 *
 * The dial is a 2×2 front-end over the bridge's `confirm-policy`
 * (`packages/cli/src/bridge/server/confirm-policy.ts`). Two axes:
 *
 *   - **tier**   : `sandbox` | `prod` (blast radius)
 *   - **review** : `review` | `no-review` (does the agent pause for confirmation?)
 *
 * giving the four named modes. Only the two **sandbox** quadrants ship in v1;
 * the prod row is rendered (reserved `--color-danger`/`--color-warning`) but
 * **locked off**: `selectable: false`. See {@link QUADRANTS}.
 *
 * ── How a mode maps to the policy ──────────────────────────────────────────
 *
 * The bridge expresses governance as a `ConfirmPolicy`
 * (`'never'|'session'|'always'|'deny'`) per tool, looked up via `policyFor`.
 * A dial mode does NOT need to enumerate tools; it maps to a `PolicyOverrides`
 * (the bridge's own override shape) + the base map + fallback the bridge should
 * build from:
 *
 *   - **Sandbox No-Review** → bridge's native sandbox behaviour: every tool
 *     `never`. Expressed as `requireConfirmAll: false`, `fallback: 'never'`,
 *     base = the sandbox base (empty → everything falls to `never`).
 *   - **Sandbox Review** → reads auto-approve, writes/deploys prompt. This is
 *     exactly `DEFAULT_PROD_POLICIES` (the conservative base), applied while
 *     staying in sandbox tier (no real blast radius). `fallback: 'always'`.
 *
 * `toPolicyRequest(mode)` returns the descriptor a set-seam would POST to the
 * bridge; the bridge would then `buildPolicyMap(base, overrides)` from it. The
 * mapping is the contract, see {@link PolicyRequest}. (The actual push seam is
 * not yet exposed by the served-app/worker; see `usePermissionDial`.)
 */

/**
 * Mirror of the bridge's confirm-policy types
 * (`packages/cli/src/bridge/server/confirm-policy.ts`). These are
 * structurally identical and intentionally re-declared here rather than
 * imported: the bridge's `./bridge` export resolves to its *browser* condition
 * (`client.d.ts`) in Studio's Vite build, which does not re-export the policy
 * types, and pulling the server build into a browser bundle is wrong. They are
 * tiny, stable, pure-data types; the source of truth is still the bridge file,
 * and {@link toPolicyRequest} produces exactly the `PolicyOverrides` shape the
 * bridge's `buildPolicyMap` consumes.
 */
export type ConfirmPolicy = 'never' | 'session' | 'always' | 'deny';

/** Mirror of the bridge's `PolicyOverrides` (see module note above). */
export interface PolicyOverrides {
  autoApprove?: string[];
  requireConfirm?: string[];
  requireConfirmAll?: boolean;
  fallback?: ConfirmPolicy;
}

/** The blast-radius axis. */
export type Tier = 'sandbox' | 'prod';

/** The autonomy axis. `review` = pause for confirmation; `no-review` = run free. */
export type Review = 'review' | 'no-review';

/** A dial mode is one cell of the 2×2 (tier × review). */
export interface DialMode {
  tier: Tier;
  review: Review;
}

/** Stable id for a quadrant: `${tier}:${review}`. Used as React key + state. */
export type DialModeId =
  | 'sandbox:review'
  | 'sandbox:no-review'
  | 'prod:review'
  | 'prod:no-review';

export function modeId(mode: DialMode): DialModeId {
  return `${mode.tier}:${mode.review}` as DialModeId;
}

export function modeFromId(id: DialModeId): DialMode {
  const [tier, review] = id.split(':') as [Tier, Review];
  return { tier, review };
}

/**
 * The bridge `base` map a mode builds its policy from. We don't import the
 * concrete `DEFAULT_PROD_POLICIES` map here (it's a runtime value the bridge
 * owns); instead we name WHICH base the bridge should start from, so the
 * descriptor stays serialisable across the (future) HTTP set-seam.
 */
export type PolicyBase = 'sandbox' | 'prod-defaults';

/**
 * A serialisable descriptor of the confirm-policy a dial mode wants. This is
 * the exact shape a set-seam would POST to the bridge, which then calls
 * `buildPolicyMap(<base>, overrides)` with `fallback`.
 */
export interface PolicyRequest {
  /** Which bridge mode the policy runs under. v1 only ever emits `sandbox`. */
  bridgeMode: Tier;
  /** Which base map the bridge should build from. */
  base: PolicyBase;
  /** Overrides merged onto the base (the bridge's own `PolicyOverrides` shape). */
  overrides: PolicyOverrides;
  /** Fallback for tools not in the base map. */
  fallback: ConfirmPolicy;
}

/** Static metadata for each quadrant: label, styling intent, selectability. */
export interface QuadrantMeta {
  id: DialModeId;
  mode: DialMode;
  label: string;
  /** One-line description shown under the label. */
  description: string;
  /** v1: only the sandbox quadrants are selectable. Prod is gated off. */
  selectable: boolean;
  /**
   * Styling intent the UI maps to token roles:
   *   - `safe`    → neutral/primary (sandbox).
   *   - `caution` → `--color-warning` (prod + review, risky but gated).
   *   - `danger`  → `--color-danger` (dangerous prod no-review, gated).
   */
  tone: 'safe' | 'caution' | 'danger';
  /** Tooltip shown for locked quadrants. */
  lockedReason?: string;
}

const PROD_LOCKED_REASON = 'prod gated off in v1';

/**
 * The 2×2, row-major (review row, then no-review row) so a CSS grid renders
 * sandbox/prod as columns and review/no-review as rows naturally.
 */
export const QUADRANTS: readonly QuadrantMeta[] = [
  {
    id: 'sandbox:review',
    mode: { tier: 'sandbox', review: 'review' },
    label: 'Sandbox · Review',
    description: 'Writes & deploys pause for confirmation. No real blast radius.',
    selectable: true,
    tone: 'safe',
  },
  {
    id: 'prod:review',
    mode: { tier: 'prod', review: 'review' },
    label: 'Prod · Review',
    description: 'Real backend. Every mutation confirmed.',
    selectable: false,
    tone: 'caution',
    lockedReason: PROD_LOCKED_REASON,
  },
  {
    id: 'sandbox:no-review',
    mode: { tier: 'sandbox', review: 'no-review' },
    label: 'Sandbox · No-Review',
    description: 'Agent runs free. Everything auto-approved in the sandbox.',
    selectable: true,
    tone: 'safe',
  },
  {
    id: 'prod:no-review',
    mode: { tier: 'prod', review: 'no-review' },
    label: 'Dangerous Prod · No-Review',
    description: 'Unconfirmed writes to the real backend. Off the rails.',
    selectable: false,
    tone: 'danger',
    lockedReason: PROD_LOCKED_REASON,
  },
];

const QUADRANT_BY_ID = new Map<DialModeId, QuadrantMeta>(
  QUADRANTS.map((q) => [q.id, q]),
);

export function quadrant(id: DialModeId): QuadrantMeta {
  const q = QUADRANT_BY_ID.get(id);
  if (!q) throw new Error(`permission-dial: unknown quadrant id "${id}"`);
  return q;
}

/** The default selected mode: Sandbox · Review (the chip the header shipped). */
export const DEFAULT_MODE_ID: DialModeId = 'sandbox:review';

/** True iff this quadrant can be selected in v1 (sandbox tier only). */
export function isSelectable(id: DialModeId): boolean {
  return quadrant(id).selectable;
}

/**
 * Map a (selectable) dial mode to the confirm-policy descriptor the bridge
 * would build. Throws for prod modes: they're gated off in v1 and must never
 * reach the policy layer (defence in depth behind the disabled UI).
 *
 * The mapping IS the contract between the dial and `confirm-policy`:
 *
 *   sandbox:no-review → base `sandbox`, fallback `never`, no overrides
 *                       ⇒ every tool resolves `never` (bridge's `DEFAULT_SANDBOX_POLICY`).
 *   sandbox:review    → base `prod-defaults`, fallback `always`
 *                       ⇒ reads `never`, writes/deploys `always`, but still in
 *                         sandbox tier, so it's "review without blast radius".
 */
export function toPolicyRequest(mode: DialMode): PolicyRequest {
  if (mode.tier === 'prod') {
    throw new Error(
      `permission-dial: prod tier is gated off in v1. ` +
        `toPolicyRequest received "${modeId(mode)}". ` +
        `The UI must not let a prod quadrant be selected.`,
    );
  }

  if (mode.review === 'no-review') {
    return {
      bridgeMode: 'sandbox',
      base: 'sandbox',
      overrides: {},
      fallback: 'never',
    };
  }

  // sandbox:review: conservative prod-defaults base, applied in sandbox tier.
  return {
    bridgeMode: 'sandbox',
    base: 'prod-defaults',
    overrides: {},
    fallback: 'always',
  };
}
