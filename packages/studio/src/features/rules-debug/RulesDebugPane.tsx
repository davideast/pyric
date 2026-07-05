/**
 * Rules-failure debugging pane (Pyric Studio F4): the Rules tab body.
 *
 * Wraps {@link RulesDebug} with the Studio pane conventions (mirrors `panes.tsx`):
 * a backend-aware empty state, and it owns the edited-ruleset text buffer.
 *
 * LIVE vs PENDING (honest):
 *   - The denial → rule → request.auth → path/op surface is driven by the
 *     `denials` it's handed (from `selectDenials(sandbox.history())`). The Studio
 *     shell's live event feed lands with T3's local backend (Wave-2 wiring), so
 *     today the pane mounts with an EMPTY denials list and a backend-aware empty
 *     state, exactly like the auth/firestore/traffic panes.
 *   - Both re-run paths are fully IMPLEMENTED + unit-tested in `rerun.ts`. They're
 *     handed to the component as callbacks ONLY when the live worker client +
 *     sandbox snapshot are available (a future prop, threaded once T3 resolves the
 *     env). Until then the component shows the "wired once the backend is
 *     reachable" hint, while the rule/context view stays fully functional.
 *
 * The pane accepts `denials` + the live hooks as optional props so a host that
 * HAS the feed (a test, or the wired shell) can drive it end-to-end without any
 * change here.
 */

import { useState } from 'react';
import { useEnvironment, type EnvironmentStatus } from '../../shell/environment.js';
import { RulesDebug } from './RulesDebug.js';
import type { Denial } from './model.js';
import type { EditedRulesetRerun, RerunResult } from './rerun.js';

export interface RulesDebugPaneProps {
  /** Denied ops to render (from `selectDenials`). Defaults to none until the
   *  shell's live event feed is wired (T3). */
  denials?: readonly Denial[];
  /** Live impersonation re-run, when the worker client is available. */
  onRerunAsUser?: (denial: Denial) => Promise<RerunResult>;
  /** Live edited-ruleset re-run (fork + diff), when a snapshot is available. */
  onRerunAgainstRules?: (denial: Denial, rules: string) => Promise<EditedRulesetRerun>;
}

export function RulesDebugPane({
  denials = [],
  onRerunAsUser,
  onRerunAgainstRules,
}: RulesDebugPaneProps) {
  const { status } = useEnvironment();
  const [editedRules, setEditedRules] = useState('');

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col">
      <RulesDebug
        denials={denials}
        editedRules={editedRules}
        onEditedRulesChange={onRerunAgainstRules ? setEditedRules : undefined}
        onRerunAsUser={onRerunAsUser}
        onRerunAgainstRules={onRerunAgainstRules}
        emptyState={<RulesEmpty status={status} />}
      />
    </div>
  );
}

function RulesEmpty({ status }: { status: EnvironmentStatus }) {
  const backendLive = status === 'ready';
  return (
    <div
      data-pyric-ui="rules-debug-empty-state"
      className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center"
    >
      {!backendLive ? (
        <span className="rounded-full border border-border px-3 py-1 text-xs uppercase tracking-wide text-slate-gray">
          Local backend pending
        </span>
      ) : null}
      <p className="max-w-md text-sm leading-relaxed text-slate-gray">
        {backendLive
          ? 'No denied operations yet. When a request is rejected by rules, it shows up here with the rule that denied it, the request.auth context, and one-click re-runs as the user or against an edited ruleset.'
          : 'Rules-failure debugging mounts here. Denied operations stream in once the local sandbox backend is reachable (T3); then each one shows the denying rule, request.auth, and the two re-run paths.'}
      </p>
    </div>
  );
}
