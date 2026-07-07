/**
 * Compose bar pinned to the bottom of the right panel. Textarea +
 * Send/Stop, plus an optional ✨ Enhance toggle row above the
 * textarea.
 *
 * When `enhanceMode` is true, the Send button label flips to
 * "Enhance →" so the action label matches what's actually about to
 * happen (a single-turn enhancement call, not the main agent loop).
 * The same submit handler fires either way — the parent's
 * `handleSubmit` branches on `enhanceMode`.
 *
 * Purely presentational — caller owns the submit handler and the
 * toggle state.
 */
import { useRef, useState, useEffect } from 'react';
import { ContextWindowMeter } from './ContextWindowMeter';
import { useSlashCommands } from './SlashCommandMenu';
import { listSkills } from '~/lib/skills/registry';
import { useSkillsStore } from '~/lib/store/skills';
import type { ContextWindowSnapshot } from '~/lib/agent/context-window';

export interface ComposeBarProps {
  /** Submit callback — receives the trimmed composer text. The bar
   *  owns its own input state (perf: keystrokes must not re-render
   *  the page root; see #787-adjacent typing-latency fix). */
  onSubmit: (text: string) => void;
  /** One-way external write (enhancer edit drops text back into the
   *  composer). Bump `nonce` to apply; the bar copies `text` into its
   *  local state. */
  externalText?: { text: string; nonce: number } | null;
  onStop?: () => void;
  sending?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** When true, render the Send button as "Enhance →" and show the
   *  toggle in the "on" position. When false the bar behaves like the
   *  pre-enhancer playground (toggle off, Send as today). */
  enhanceMode?: boolean;
  /** Called when the user clicks the ✨ Enhance toggle. */
  onToggleEnhance?: () => void;
  contextWindow?: ContextWindowSnapshot;
  onOpenContext?: () => void;
}

export function ComposeBar({
  onSubmit,
  externalText = null,
  onStop,
  sending = false,
  disabled = false,
  placeholder = 'Ask the agent to write rules, change code, or run something…',
  enhanceMode = false,
  onToggleEnhance,
  contextWindow,
  onOpenContext,
}: ComposeBarProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // LOCAL input state — the whole point. Lifting this to the page
  // root made every keystroke re-render the full tree (message feed
  // incl. markdown re-parse, panels), which is seconds of latency on
  // long sessions.
  const [value, setValue] = useState('');
  const appliedNonce = useRef<number | null>(null);
  useEffect(() => {
    if (externalText && externalText.nonce !== appliedNonce.current) {
      appliedNonce.current = externalText.nonce;
      setValue(externalText.text);
    }
  }, [externalText]);
  const canSubmit = !disabled && !sending && value.trim().length > 0;
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    setValue('');
    onSubmit(text);
  };

  // `/` command menu — items are the session's skills. Selection
  // toggles the skills store; AgentModeControl reflects the state.
  // One pragmatic store read in an otherwise presentational component:
  // threading toggle props through PlaygroundPage buys nothing here.
  const activeSkillIds = useSkillsStore((s) => s.activeSkillIds);
  const toggleSkill = useSkillsStore((s) => s.toggleSkill);
  const slash = useSlashCommands({
    value,
    onChange: setValue,
    textareaRef: taRef,
    items: listSkills().map((s) => ({
      id: s.id,
      icon: s.icon,
      label: s.label,
      description: s.description,
      active: activeSkillIds.includes(s.id),
    })),
    onSelect: (item) => toggleSkill(item.id),
  });

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.onKeyDown(e)) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 border-t border-[#2a2a35] bg-sidebar-bg p-3 grid gap-2">
      {/* Enhance toggle — only rendered when the parent wires it up.
          Inline above the textarea so the user sees, before typing,
          that their next Send will route through the enhancer. */}
      {onToggleEnhance ? (
        <button
          type="button"
          onClick={onToggleEnhance}
          aria-pressed={enhanceMode}
          className={[
            'inline-flex items-center gap-2 self-start px-2.5 py-1 rounded-full border text-[11px] font-mono uppercase tracking-wider transition-colors',
            enhanceMode
              ? 'border-soft-white/60 bg-soft-white/10 text-soft-white'
              : 'border-[#2a2a35] text-slate-gray hover:text-soft-white hover:border-[#3a3a45]',
          ].join(' ')}
          title={
            enhanceMode
              ? 'Click to turn off prompt enhancement'
              : 'Rewrite your rough idea into a well-shaped playground prompt first. You\'ll see the result as an approval card.'
          }
        >
          <span className="material-symbols-outlined text-[14px]">auto_awesome</span>
          <span>Enhance</span>
          <span
            className={[
              'inline-flex items-center w-7 h-3.5 rounded-full transition-colors',
              enhanceMode ? 'bg-soft-white/70' : 'bg-[#2a2a35]',
            ].join(' ')}
            aria-hidden
          >
            <span
              className={[
                'block w-3 h-3 rounded-full bg-[#0f0f17] transition-transform',
                enhanceMode ? 'translate-x-3.5' : 'translate-x-0.5',
              ].join(' ')}
            />
          </span>
        </button>
      ) : null}

      <div className="relative">
        {slash.menu}
        <textarea
          ref={taRef}
          className="w-full bg-content-bg border border-[#2a2a35] rounded-md px-3 py-2.5 text-[13px] text-soft-white placeholder:text-slate-gray/60 focus:outline-none focus:border-slate-gray transition-colors font-display resize-none min-h-[64px] max-h-[200px]"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          rows={3}
          spellCheck={false}
          disabled={disabled || sending}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-slate-gray">
          ⌘ / Ctrl + Enter to send
          <span className="hidden sm:inline"> · type / for skills</span>
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {contextWindow ? (
            <ContextWindowMeter snapshot={contextWindow} onOpen={onOpenContext} />
          ) : null}
          {sending && onStop ? (
            <button
              type="button"
              onClick={onStop}
              className="px-3 py-1.5 rounded-full border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors text-[12px] font-semibold"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className={[
                'px-4 py-1.5 rounded-full text-[12px] font-semibold transition-colors inline-flex items-center gap-1.5',
                canSubmit
                  ? 'bg-soft-white text-content-bg hover:bg-white'
                  : 'bg-soft-white/20 text-soft-white/40 cursor-not-allowed',
              ].join(' ')}
            >
              {enhanceMode ? (
                <>
                  <span className="material-symbols-outlined text-[14px]">auto_awesome</span>
                  <span>Enhance</span>
                </>
              ) : (
                <span>Send</span>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
