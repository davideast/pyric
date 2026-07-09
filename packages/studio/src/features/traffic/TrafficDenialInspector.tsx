/**
 * The Traffic surface's denial inspection mount (rules-debug F4, wired in).
 *
 * Composition: `DenialDetail` (features/rules-debug) stays pure-props; THIS
 * component is the Traffic-side adapter that resolves its dependencies from
 * the shell data seam and hands them down:
 *   - the selected {@link Denial} — found by id in `useStudioDenials()` (the
 *     `selectDenials` projection over the live event stream);
 *   - re-run deps — `useStudioSnapshot()` (fork source) + `useStudioRulesSource()`
 *     (the deployed ruleset), the SAME wiring the de-mounted RulesSurface used:
 *     both re-runs happen on a THROWAWAY fork, never a live mutation;
 *   - the edited-ruleset text buffer (local, prefilled with the live rules the
 *     first time the inspector opens for a denial).
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
  useStudioDenials,
  useStudioSnapshot,
  useStudioRulesSource,
} from '../../shell/studio-data.js';

export function TrafficDenialInspector({
  denialId,
  onClose,
}: {
  denialId: string;
  onClose: () => void;
}) {
  const denials = useStudioDenials();
  const getSnapshot = useStudioSnapshot();
  const rulesSource = useStudioRulesSource();
  const denial = denials.find((d) => d.id === denialId);

  // The "what if" buffer. Keyed per denial by the parent (`key={denialId}`),
  // so switching denials resets it; prefilled from the live rules once they
  // resolve (served mode loads them async).
  const [editedRules, setEditedRules] = useState('');
  const effectiveEditedRules = editedRules || rulesSource;

  if (!denial) {
    return (
      <div
        data-pyric-ui="traffic-denial-missing"
        className="traffic__denial-inspector"
      >
        <p className="traffic__denial-missing">
          This denial isn't in this session's traffic. It may be from an
          earlier session, or the event has aged out of the buffer.
        </p>
        <button type="button" className="traffic__denial-close" onClick={onClose}>
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
      data-pyric-ui="traffic-denial-inspector"
      className="traffic__denial-inspector"
    >
      <div className="traffic__denial-bar">
        <span className="traffic__denial-title">denial inspection</span>
        <button
          type="button"
          className="traffic__denial-close"
          onClick={onClose}
          aria-label="Close denial inspection (Esc)"
        >
          close (esc)
        </button>
      </div>
      <DenialDetail
        denial={denial}
        editedRules={effectiveEditedRules}
        onEditedRulesChange={setEditedRules}
        onRerunAsUser={onRerunAsUser}
        onRerunAgainstRules={onRerunAgainstRules}
      />
    </div>
  );
}
