/**
 * Permission dial (F3): public surface.
 *
 * A 2×2 (review × tier) front-end over the bridge's `confirm-policy`. Sandbox
 * tier only in v1; the prod column is styled (reserved `--color-danger` /
 * `--color-warning`) but gated off.
 */
export { PermissionDial, type PermissionDialProps } from './PermissionDial.js';
export {
  usePermissionDial,
  type PermissionDialState,
  type UsePermissionDialOptions,
} from './usePermissionDial.js';
export {
  QUADRANTS,
  DEFAULT_MODE_ID,
  modeId,
  modeFromId,
  quadrant,
  isSelectable,
  toPolicyRequest,
  type ConfirmPolicy,
  type DialMode,
  type DialModeId,
  type PolicyBase,
  type PolicyOverrides,
  type PolicyRequest,
  type QuadrantMeta,
  type Review,
  type Tier,
} from './policy.js';
