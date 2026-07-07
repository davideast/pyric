/**
 * In-panel card for AI-generated seed proposals on the Seed tab.
 */
import type { SeedGeneration } from '~/lib/store/seed-generator';
import type { SeedProposalV1 } from '~/lib/seed-generator/schema';

interface Props {
  generation: SeedGeneration;
  onApply: (id: string, proposal: SeedProposalV1) => void;
  onEdit: (id: string, proposal: SeedProposalV1) => void;
  onDiscard: (id: string) => void;
  onRetry: (id: string) => void;
  applyBusy?: boolean;
}

function summarizeProposal(proposal: SeedProposalV1 | null): string {
  if (!proposal) return '';
  const collCount = Object.keys(proposal.firestore).length;
  let docCount = 0;
  for (const v of Object.values(proposal.firestore)) {
    if (Array.isArray(v)) docCount += v.length;
    else docCount += Object.keys(v).length;
  }
  const authCount = proposal.auth?.length ?? 0;
  const parts = [`${collCount} collection${collCount === 1 ? '' : 's'}`, `${docCount} doc${docCount === 1 ? '' : 's'}`];
  if (authCount > 0) parts.push(`${authCount} identit${authCount === 1 ? 'y' : 'ies'}`);
  return parts.join(' · ');
}

export function SeedGenerationCard({
  generation,
  onApply,
  onEdit,
  onDiscard,
  onRetry,
  applyBusy,
}: Props) {
  const { id, state, rawStream, parsedProposal, errorMessage, summary } = {
    ...generation,
    summary: generation.parsedProposal?.summary,
  };

  const isLive = state === 'streaming' || state === 'ready' || state === 'applying';

  return (
    <article
      className={[
        'rounded-lg border bg-sidebar-bg',
        state === 'errored' ? 'border-red-500/30' : 'border-[#2a2a35]',
      ].join(' ')}
    >
      <header className="flex items-center justify-between gap-2 border-b border-[#2a2a35]/60 px-3 py-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-soft-white">
          Generated seed
        </span>
        {state === 'streaming' ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono text-slate-gray">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-slate-gray" />
            generating
          </span>
        ) : state === 'applying' ? (
          <span className="text-[10px] font-mono text-slate-gray">applying…</span>
        ) : state === 'applied' ? (
          <span className="text-[10px] font-mono uppercase tracking-wider text-[#a4d4a8]">
            applied
          </span>
        ) : state === 'discarded' ? (
          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-gray">
            discarded
          </span>
        ) : state === 'errored' ? (
          <span className="text-[10px] font-mono uppercase tracking-wider text-red-400">failed</span>
        ) : parsedProposal ? (
          <span className="text-[10px] font-mono text-slate-gray">{summarizeProposal(parsedProposal)}</span>
        ) : null}
      </header>

      <div className="grid gap-2 px-3 py-2.5">
        {summary ? (
          <p className="text-[12px] leading-relaxed text-slate-gray">{summary}</p>
        ) : null}

        {state === 'errored' ? (
          <p className="text-[12px] leading-relaxed text-red-300/90">
            {errorMessage ?? 'Generation failed.'}
          </p>
        ) : (
          <pre className="max-h-48 overflow-auto rounded-md border border-[#2a2a35] bg-content-bg p-2 font-mono text-[11px] leading-relaxed text-soft-white/90 whitespace-pre-wrap">
            {rawStream || (state === 'streaming' ? '…' : '')}
          </pre>
        )}

        {parsedProposal && state === 'ready' ? (
          <ul className="text-[11px] text-slate-gray">
            {Object.keys(parsedProposal.firestore).map((c) => (
              <li key={c} className="font-mono">
                {c}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {isLive && state !== 'streaming' && state !== 'applying' && parsedProposal ? (
        <footer className="flex flex-wrap items-center gap-2 border-t border-[#2a2a35]/60 px-3 py-2">
          <button
            type="button"
            disabled={applyBusy}
            onClick={() => onApply(id, parsedProposal)}
            className="h-7 rounded-md bg-[#5b5bd6] px-3 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            Apply to sandbox
          </button>
          <button
            type="button"
            onClick={() => onEdit(id, parsedProposal)}
            className="h-7 rounded-md border border-[#2a2a35] px-3 text-[11px] text-slate-gray hover:text-soft-white"
          >
            Edit in JSON
          </button>
          <button
            type="button"
            onClick={() => onDiscard(id)}
            className="h-7 rounded-md px-2 text-[11px] text-slate-gray hover:text-[#f0a0a0]"
          >
            Discard
          </button>
        </footer>
      ) : null}

      {state === 'errored' ? (
        <footer className="flex gap-2 border-t border-[#2a2a35]/60 px-3 py-2">
          <button
            type="button"
            onClick={() => onRetry(id)}
            className="h-7 rounded-md border border-[#2a2a35] px-3 text-[11px] text-slate-gray hover:text-soft-white"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => onDiscard(id)}
            className="h-7 rounded-md px-2 text-[11px] text-slate-gray hover:text-[#f0a0a0]"
          >
            Discard
          </button>
        </footer>
      ) : null}
    </article>
  );
}
