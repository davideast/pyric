/**
 * The Traffic surface's RULES INSPECTOR mount (rules-debug F4, wired in).
 * Opens for ANY rules-evaluated op — an allowed row shows the rule that
 * granted access (✓ line marker, matched rule, trace); a denied row shows the
 * rule that rejected it (✗) — same anatomy either way.
 *
 * Composition: `DenialDetail` (features/rules-debug) stays pure-props; THIS
 * component is the Traffic-side adapter that resolves its dependencies from
 * the shell data seam and hands them down:
 *   - the selected op — found by id in `useStudioRuleEvaluations()` (the
 *     `selectRuleEvaluations` projection over the live event stream: allow AND
 *     deny/unsupported);
 *   - re-run deps — `useStudioSnapshot()` (fork source) + `useStudioRulesSource()`
 *     (the deployed ruleset), the SAME wiring the de-mounted RulesSurface used:
 *     both re-runs happen on a THROWAWAY fork, never a live mutation. For an
 *     ALLOWED op the edited-ruleset re-run answers "would my edit BREAK this?"
 *     — the same divergence diff reports flips both ways;
 *   - the edited-ruleset text buffer (local, prefilled with the live rules the
 *     first time the inspector opens for an op).
 *
 * When the id isn't in the current event buffer (a stale deep link, or the
 * event aged past the STUDIO_EVENT_CAP window), it renders a calm
 * "not in this session's traffic" state instead of crashing.
 */

import { useState } from 'react';
import { fork, discard } from 'pyric/sandbox';
import {
  DenialDetail,
  issueOp,
  rerunAgainstRules,
  type Denial,
  type EditedRulesetRerun,
  type RerunResult,
} from '../rules-debug/index.js';
import {
  useStudioRuleEvaluations,
  useStudioSnapshot,
  useStudioRulesSource,
} from '../../shell/studio-data.js';

export function TrafficRulesInspector({
  eventId,
  onClose,
}: {
  /** The inspected op's request-event id (`?inspect=<id>`). */
  eventId: string;
  onClose: () => void;
}) {
  const ops = useStudioRuleEvaluations();
  const getSnapshot = useStudioSnapshot();
  const rulesSource = useStudioRulesSource();
  const op = ops.find((d) => d.id === eventId);

  // The "what if" buffer. Keyed per op by the parent (`key={eventId}`), so
  // switching ops resets it; prefilled from the live rules once they resolve
  // (served mode loads them async).
  const [editedRules, setEditedRules] = useState('');
  const effectiveEditedRules = editedRules || rulesSource;

  if (!op) {
    return (
      <div
        data-pyric-ui="traffic-inspect-missing"
        className="traffic__inspector"
      >
        <p className="traffic__inspector-missing">
          This operation isn't in this session's traffic. It may be from an
          earlier session, or the event has aged out of the buffer.
        </p>
        <button type="button" className="traffic__inspector-close" onClick={onClose}>
          Back to the log
        </button>
      </div>
    );
  }

  // Re-run as the attempting user: reproduce on a throwaway fork of the
  // CURRENT snapshot under the CURRENT rules (same-decision check). Honest
  // about the no-backend case rather than guessing.
  const onRerunAsUser = async (d: Denial): Promise<RerunResult> => {
    const snap = await getSnapshot();
    if (!snap) {
      return {
        outcome: 'error',
        code: 'no-backend',
        message: 'No sandbox snapshot to re-run against.',
      };
    }
    const branch = fork(snap, rulesSource);
    try {
      return await issueOp(branch.sandbox, d);
    } finally {
      discard(branch);
    }
  };

  // Re-run against an edited ruleset: lint → fork → re-issue → diff
  // (rules-debug's rerunAgainstRules; the fork is discarded either way).
  const onRerunAgainstRules = async (
    d: Denial,
    rules: string,
  ): Promise<EditedRulesetRerun> => {
    const snap = await getSnapshot();
    if (!snap) {
      return {
        result: {
          outcome: 'error',
          code: 'no-backend',
          message: 'No sandbox snapshot to re-run against.',
        },
        diff: [],
        lint: { parseable: true, findings: [] },
      };
    }
    return rerunAgainstRules(snap, d, rules, snap);
  };

  return (
    <div
      data-pyric-ui="traffic-rules-inspector"
      className="traffic__inspector"
    >
      <div className="traffic__inspector-bar">
        <span className="traffic__inspector-title">rules inspector</span>
        <button
          type="button"
          className="traffic__inspector-close"
          onClick={onClose}
          aria-label="Close rules inspector (Esc)"
        >
          close (esc)
        </button>
      </div>
      <DenialDetail
        denial={op}
        editedRules={effectiveEditedRules}
        rulesSource={rulesSource}
        onEditedRulesChange={setEditedRules}
        onRerunAsUser={onRerunAsUser}
        onRerunAgainstRules={onRerunAgainstRules}
      />
    </div>
  );
}
