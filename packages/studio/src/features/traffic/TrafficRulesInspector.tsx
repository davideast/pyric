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

import { fork, discard } from 'pyric/sandbox';
import {
  DenialDetail,
  issueOp,
  type Denial,
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
  const op = ops.find((d) => d.id === eventId);
  const targetService = op?.service ?? 'firestore';
  const rulesSource = useStudioRulesSource(targetService);

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
        rulesSource={rulesSource}
        onRerunAsUser={onRerunAsUser}
      />
    </div>
  );
}
