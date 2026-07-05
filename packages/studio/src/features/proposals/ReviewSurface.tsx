/**
 * Review surface (AI-as-flow): `mocks/c-review.html` as a live surface.
 *
 * Shows the staged change focused from a session action item: the diff
 * (`diff(branch, live-now)`, never stale) rendered through the `@pyric/ui/events`
 * `ProposedChangeDiff`, plus the gated decision (Apply / Discard). Apply promotes
 * the staged writes onto live; if live drifted since staging, it surfaces the
 * conflicts and offers force. Discard drops the copy.
 */

import { useEffect, useMemo, useState } from 'react';
import { ProposedChangeDiff, type FieldChange, type CreatedAuthUser } from '@pyric/ui/events';
import type { Divergence } from 'pyric/sandbox';
import {
  useProposals,
  useFocusedProposalId,
  focusProposal,
  type ApplyResult,
} from './proposals.js';
import './proposals.css';

/** Adapt the sandbox's `Divergence[]` to the UI-level `FieldChange[]`. */
function toFieldChanges(divergences: Divergence[]): FieldChange[] {
  return divergences.flatMap((d): FieldChange[] => {
    if (!('path' in d)) return [];
    const path = (d as { path: string }).path;
    const field = 'field' in d && d.field ? String(d.field) : '(document)';
    const before = (d as { before?: unknown }).before;
    const after = (d as { after?: unknown }).after;
    const kind: FieldChange['kind'] =
      before === undefined ? 'added' : after === undefined ? 'removed' : 'changed';
    return [{ docPath: path, field, before, after, kind }];
  });
}

function actorLabel(actor: string): string {
  if (actor === 'you') return 'you';
  if (actor === 'studio') return 'Studio';
  if (actor.startsWith('agent:')) return `an agent (${actor.slice('agent:'.length)})`;
  return actor;
}

function goToSession(): void {
  focusProposal(null);
  if (typeof window !== 'undefined') window.location.hash = 'session';
}

export function ReviewSurface() {
  const id = useFocusedProposalId();
  const { get, freshDiff, apply, discard } = useProposals();
  const proposal = id ? get(id) : undefined;

  const [changes, setChanges] = useState<FieldChange[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApplyResult | { status: 'error'; message: string } | null>(null);

  useEffect(() => {
    let alive = true;
    if (!id) {
      setChanges([]);
      return;
    }
    freshDiff(id).then((divs) => {
      if (alive) setChanges(toFieldChanges(divs));
    });
    return () => {
      alive = false;
    };
  }, [id, freshDiff, result]);

  const docCount = useMemo(() => new Set(changes.map((c) => c.docPath)).size, [changes]);
  // Auth users come from the proposal's captured ops (diff() is Firestore-only),
  // so they reflect what apply will create, not a live diff.
  const authUsers = useMemo<CreatedAuthUser[]>(
    () =>
      (proposal?.authOps ?? []).map((op) => ({
        uid: op.request.uid ?? '(auto)',
        email: op.request.email,
        displayName: op.request.displayName,
        emailVerified: op.request.emailVerified,
      })),
    [proposal],
  );

  if (!proposal || proposal.status !== 'open') {
    return (
      <section className="review" data-pyric-ui="review-surface">
        <p className="review__empty">
          No staged change selected. Stage one from the session to review it here.
        </p>
      </section>
    );
  }

  const runApply = async (force?: boolean) => {
    setBusy(true);
    try {
      const r = await apply(proposal.id, force ? { force: true } : undefined);
      setResult(r);
      if (r.status === 'applied') goToSession();
    } catch (e) {
      setResult({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const conflict = result && result.status === 'conflict' ? result : null;

  return (
    <section className="review" data-pyric-ui="review-surface">
      <button type="button" className="review__back" onClick={goToSession}>
        ‹ Back to session
      </button>

      <p className="review__eyebrow">Staged change · not committed</p>
      <h1 className="review__title">{proposal.title}</h1>
      <p className="review__meta">
        staged by {actorLabel(proposal.actor)} <span className="review__sep">·</span> ran on a copy
        {authUsers.length > 0 ? (
          <>
            {' '}
            <span className="review__sep">·</span> {authUsers.length}{' '}
            {authUsers.length === 1 ? 'user' : 'users'}
          </>
        ) : null}{' '}
        <span className="review__sep">·</span> {docCount} {docCount === 1 ? 'document' : 'documents'}
      </p>

      <ProposedChangeDiff
        changes={changes}
        authUsers={authUsers}
        className="review__diff"
        emptyState={
          <p className="review__empty">
            This change no longer differs from live (it may have already been applied).
          </p>
        }
      />

      <div className="review__decide">
        {conflict ? (
          <div className="review__conflict" role="alert">
            <p className="review__conflict-head">
              {conflict.conflicts.length}{' '}
              {conflict.conflicts.length === 1 ? 'document' : 'documents'} changed in live since
              this was staged.
            </p>
            <ul className="review__conflict-list">
              {conflict.conflicts.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="review__actions">
          <button
            type="button"
            className="review__apply"
            disabled={busy}
            onClick={() => void runApply(conflict ? true : false)}
          >
            {busy ? 'Applying…' : conflict ? 'Apply anyway' : 'Apply to live'}
          </button>
          <button
            type="button"
            className="review__discard"
            disabled={busy}
            onClick={() => {
              discard(proposal.id);
              goToSession();
            }}
          >
            Discard
          </button>
        </div>

        {result && result.status === 'error' ? (
          <p className="review__error">Apply failed: {result.message}</p>
        ) : null}

        <p className="review__help">
          Apply writes the staged documents onto live (the gated step). Discard drops the copy;
          nothing was ever written to live until you apply.
        </p>
      </div>
    </section>
  );
}
