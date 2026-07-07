/**
 * Firebase > Ideas tab (feature #4). A discovery surface for "what to
 * build next". Two layers:
 *   - AI-generated ideas tailored to the current app (rules + files +
 *     App.tsx calls + sandbox schema + recent prompts), produced by a
 *     standalone, cached, digest-driven call. See lib/agent/ideas/generate.
 *   - Curated STARTER ideas (lib/firebase-ideas) as the instant paint +
 *     the fresh-session / no-key / error fallback.
 *
 * Tapping a card drills into a detail view (what gets built + an editable
 * example prompt); "Send to agent" hands the prompt to the agent loop and
 * moves the view to the chat (the SuggestionsTab idiom:
 * `onSendPrompt(text)` then `onAfterSend()`).
 *
 * Generation is LAZY (on tab open, only when the app-state hash changed)
 * plus a manual refresh, so a static session costs zero tokens.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FIREBASE_IDEAS, type FirebaseIdea } from '~/lib/firebase-ideas';
import {
  buildIdeasDigest,
  generateIdeas,
  getCachedIdeas,
  setCachedIdeas,
} from '~/lib/agent/ideas/generate';
import { useLlmStore } from '~/lib/store/llm';
import { PROVIDERS } from '~/lib/llm/registry';

export interface IdeasTabProps {
  onSendPrompt?: (prompt: string) => void;
  sendBusy?: boolean;
  /** Called after a send so the parent can switch to the chat view. */
  onAfterSend?: () => void;
}

type GenStatus = 'idle' | 'loading' | 'error';

export function IdeasTab({ onSendPrompt, sendBusy, onAfterSend }: IdeasTabProps) {
  const [selected, setSelected] = useState<FirebaseIdea | null>(null);
  const [prompt, setPrompt] = useState('');

  const [dynamicIdeas, setDynamicIdeas] = useState<FirebaseIdea[] | null>(null);
  const [status, setStatus] = useState<GenStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const providerId = useLlmStore((s) => s.providerId);
  const modelId = useLlmStore((s) => s.modelId);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(
    async (force: boolean) => {
      abortRef.current?.abort();
      setErrorMsg(null);
      const digest = await buildIdeasDigest();
      // Nothing to reason about yet, or no key to call with → curated
      // starters only, zero tokens.
      const apiKey = PROVIDERS[providerId]?.byok.getKey() ?? null;
      if (digest.empty || !apiKey) {
        setDynamicIdeas([]);
        setStatus('idle');
        return;
      }
      if (!force) {
        const cached = getCachedIdeas(digest.hash);
        if (cached) {
          setDynamicIdeas(cached);
          setStatus('idle');
          return;
        }
      }
      const ac = new AbortController();
      abortRef.current = ac;
      setStatus('loading');
      try {
        const ideas = await generateIdeas({
          providerId,
          modelId,
          apiKey,
          digest: digest.text,
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        setCachedIdeas(digest.hash, ideas);
        setDynamicIdeas(ideas);
        setStatus('idle');
      } catch (e) {
        if (ac.signal.aborted) return;
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setStatus('error');
        setDynamicIdeas([]);
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
      }
    },
    [providerId, modelId],
  );

  // Lazy generate when the tab opens (this component mounts on open).
  useEffect(() => {
    void refresh(false);
    return () => abortRef.current?.abort();
  }, [refresh]);

  const openIdea = (idea: FirebaseIdea) => {
    setSelected(idea);
    setPrompt(idea.examplePrompt);
  };

  const send = () => {
    const text = prompt.trim();
    if (!text || !onSendPrompt || sendBusy) return;
    onSendPrompt(text);
    onAfterSend?.();
  };

  // ─── Detail (drill-in) ─────────────────────────────────────────────
  if (selected) {
    const builds = selected.builds ?? [];
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto custom-scrollbar bg-content-bg">
        <div className="flex items-center gap-2 border-b border-[#2a2a35] px-4 py-3">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="inline-flex items-center justify-center rounded p-1 text-slate-gray transition-colors hover:text-soft-white"
            title="Back to ideas"
            aria-label="Back to ideas"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          </button>
          <span className="material-symbols-outlined text-[18px] text-[#a4c4f0]">
            {selected.icon}
          </span>
          <span className="text-[13px] font-semibold text-soft-white">{selected.title}</span>
        </div>

        <div className="flex flex-col gap-4 px-4 py-4">
          <div>
            <div className="mb-2 text-[10px] font-mono uppercase tracking-wider text-slate-gray">
              {builds.length ? 'What gets built' : 'About'}
            </div>
            {builds.length ? (
              <ul className="flex flex-col gap-1.5">
                {builds.map((line) => (
                  <li key={line} className="flex items-start gap-2 text-[12px] text-soft-white/80">
                    <span className="material-symbols-outlined mt-0.5 text-[14px] text-[#a4d4a8]">
                      check
                    </span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] leading-relaxed text-soft-white/80">{selected.tagline}</p>
            )}
          </div>

          <div>
            <div className="mb-2 text-[10px] font-mono uppercase tracking-wider text-slate-gray">
              Example prompt (edit before sending)
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={7}
              className="w-full resize-y rounded-md border border-[#2a2a35] bg-sidebar-bg px-3 py-2 text-[12px] leading-relaxed text-soft-white outline-none transition-colors focus:border-soft-white/40"
            />
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded-md px-3 py-1.5 text-[12px] font-medium text-slate-gray transition-colors hover:text-soft-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={send}
              disabled={!onSendPrompt || sendBusy || prompt.trim().length === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-soft-white px-3 py-1.5 text-[12px] font-semibold text-[#0f0f17] transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-[15px]">send</span>
              {sendBusy ? 'Sending…' : 'Send to agent'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── List ──────────────────────────────────────────────────────────
  const hasDynamic = (dynamicIdeas?.length ?? 0) > 0;
  const canGenerate = Boolean(PROVIDERS[providerId]?.byok.getKey());

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto custom-scrollbar bg-content-bg">
      <div className="flex items-start justify-between gap-2 px-4 pt-4">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-gray">Ideas</div>
          <p className="mt-1 text-[12px] text-soft-white/70">
            {canGenerate
              ? 'Suggestions tailored to your app, plus starters. Each opens an editable prompt.'
              : 'Pick a Firebase feature to build. Set an API key to get ideas tailored to your app.'}
          </p>
        </div>
        {canGenerate ? (
          <button
            type="button"
            onClick={() => void refresh(true)}
            disabled={status === 'loading'}
            title="Regenerate suggestions"
            aria-label="Regenerate suggestions"
            className="inline-flex shrink-0 items-center justify-center rounded p-1.5 text-slate-gray transition-colors hover:text-soft-white disabled:opacity-40"
          >
            <span
              className={[
                'material-symbols-outlined text-[18px]',
                status === 'loading' ? 'animate-spin' : '',
              ].join(' ')}
            >
              autorenew
            </span>
          </button>
        ) : null}
      </div>

      {status === 'loading' && !hasDynamic ? (
        <div className="flex items-center gap-2 px-4 pt-3 text-[12px] text-slate-gray">
          <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
          Analyzing your app…
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="px-4 pt-3 text-[11px] text-[#f0a0a0]">
          Couldn&apos;t generate suggestions ({errorMsg}). Showing starters.
        </div>
      ) : null}

      {hasDynamic ? (
        <IdeaSection title="Suggested for this app" ideas={dynamicIdeas!} onOpen={openIdea} />
      ) : null}
      {/* Only label the starters section when it sits below the dynamic
          one; on its own it would just duplicate the header. */}
      <IdeaSection title={hasDynamic ? 'Starters' : ''} ideas={FIREBASE_IDEAS} onOpen={openIdea} />
    </div>
  );
}

function IdeaSection({
  title,
  ideas,
  onOpen,
}: {
  title: string;
  ideas: readonly FirebaseIdea[];
  onOpen: (idea: FirebaseIdea) => void;
}) {
  return (
    <div className="px-4 pb-2 pt-4">
      {title ? (
        <div className="mb-2 text-[10px] font-mono uppercase tracking-wider text-slate-gray">
          {title}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ideas.map((idea) => (
          <button
            key={idea.id}
            type="button"
            onClick={() => onOpen(idea)}
            className="flex flex-col gap-2 rounded-lg border border-[#2a2a35] bg-sidebar-bg p-3 text-left transition-colors hover:border-soft-white/40"
          >
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-[#a4c4f0]">
                {idea.icon}
              </span>
              <span className="text-[13px] font-semibold text-soft-white">{idea.title}</span>
            </div>
            {idea.tagline ? (
              <span className="text-[11px] leading-relaxed text-slate-gray">{idea.tagline}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
