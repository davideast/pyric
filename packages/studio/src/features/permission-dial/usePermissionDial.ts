/**
 * Permission dial state hook (F3).
 *
 * Owns the currently-selected dial mode and the push of that mode's
 * confirm-policy descriptor toward the bridge. Selection is constrained to the
 * **selectable** (sandbox) quadrants: `select()` rejects prod ids (which are
 * gated off in v1) so the state machine can never enter a prod mode even if the
 * UI's `disabled` were bypassed.
 *
 * ── The set-seam (honest gap) ──────────────────────────────────────────────
 *
 * `toPolicyRequest(mode)` yields the exact descriptor the bridge would build a
 * policy map from. The MISSING piece is a *runtime* channel from this browser
 * UI to the bridge: the confirm-policy is consumed in the bridge/MCP process at
 * startup (`mcp.ts`/`confirm.ts` read a pre-built `policies` map, gated only in
 * prod mode). There is no `/__pyric/*` route today that re-pushes a policy to a
 * running bridge. So this hook computes the descriptor and surfaces it via
 * `onPolicyChange`; wiring that callback to a real HTTP `PUT /__pyric/policy`
 * (and the matching serve route + bridge re-config) is the remaining seam, see
 * the F3 note in the PR. We deliberately do NOT fake a network write here.
 */

import { useCallback, useMemo, useState } from 'react';

import {
  DEFAULT_MODE_ID,
  isSelectable,
  modeFromId,
  toPolicyRequest,
  type DialModeId,
  type PolicyRequest,
} from './policy.js';

export interface UsePermissionDialOptions {
  /** Initial selected quadrant. Defaults to Sandbox · Review. */
  initial?: DialModeId;
  /**
   * Called whenever the selected mode changes, with the confirm-policy
   * descriptor the bridge should adopt. This is the set-seam hook: when the
   * `PUT /__pyric/policy` route exists, wire it here. Until then a host can at
   * least observe/log the intended policy.
   */
  onPolicyChange?: (request: PolicyRequest, id: DialModeId) => void;
}

export interface PermissionDialState {
  /** Currently selected quadrant id (always a sandbox quadrant in v1). */
  selected: DialModeId;
  /** The confirm-policy descriptor for the current selection. */
  policy: PolicyRequest;
  /**
   * Select a quadrant. No-ops (returns `false`) for non-selectable (prod) ids;
   * returns `true` when the selection changed.
   */
  select: (id: DialModeId) => boolean;
}

export function usePermissionDial(
  options: UsePermissionDialOptions = {},
): PermissionDialState {
  const { initial = DEFAULT_MODE_ID, onPolicyChange } = options;
  const [selected, setSelected] = useState<DialModeId>(
    isSelectable(initial) ? initial : DEFAULT_MODE_ID,
  );

  const policy = useMemo(
    () => toPolicyRequest(modeFromId(selected)),
    [selected],
  );

  const select = useCallback(
    (id: DialModeId): boolean => {
      if (!isSelectable(id)) return false;
      if (id === selected) return false;
      setSelected(id);
      onPolicyChange?.(toPolicyRequest(modeFromId(id)), id);
      return true;
    },
    [selected, onPolicyChange],
  );

  return { selected, policy, select };
}
