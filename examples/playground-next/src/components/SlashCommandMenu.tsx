/**
 * Slash-command menu — type `/` in a composer to pick from a filterable
 * option list (arrow keys + Enter/Tab, Esc dismisses; click works too).
 *
 * GENERIC on purpose: items are `{ id, icon, label, description,
 * active? }` and the parent owns what selection means — today the items
 * are skills (selection toggles the skill and strips the `/token` from
 * the text); future commands (seed, enhance, …) slot in as more items.
 *
 * Used by BOTH composers: the home new-session box (selection collects
 * skills for the session about to be created) and the playground
 * ComposeBar (selection toggles the live session's skills store).
 *
 * The hook owns trigger detection + keyboard state; the caller renders
 * `menu` inside a `relative` wrapper around its textarea and runs
 * `onKeyDown(e)` FIRST in its own key handler (returns true when the
 * key was consumed by the menu).
 */
import { useMemo, useRef, useState } from 'react';

export interface SlashItem {
  id: string;
  icon: string;
  label: string;
  description: string;
  /** Render an on/off state pill (for toggleable items like skills). */
  active?: boolean;
}

export interface SlashToken {
  /** Index of the `/` in the value. */
  start: number;
  /** End of the token (exclusive). */
  end: number;
  /** Text after the slash, lowercased. */
  query: string;
}

/** Find a `/query` token containing the caret: a `/` at the start of
 *  the input or after whitespace, followed by word chars only, with
 *  the caret inside or at the end of it. Exported for tests. */
export function slashTokenAt(value: string, caret: number): SlashToken | null {
  // Walk back from the caret to the nearest whitespace boundary.
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1]!)) start--;
  if (value[start] !== '/') return null;
  let end = caret;
  while (end < value.length && !/\s/.test(value[end]!)) end++;
  const body = value.slice(start + 1, end);
  if (!/^[\w-]*$/.test(body)) return null;
  return { start, end, query: body.toLowerCase() };
}

/** Filter + rank: id/label prefix matches first, then substring matches
 *  on id/label/description. Exported for tests. */
export function filterSlashItems<T extends SlashItem>(items: readonly T[], query: string): T[] {
  if (!query) return [...items];
  const q = query.toLowerCase();
  const prefix: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    const id = item.id.toLowerCase();
    const label = item.label.toLowerCase();
    if (id.startsWith(q) || label.startsWith(q)) prefix.push(item);
    else if (id.includes(q) || label.includes(q) || item.description.toLowerCase().includes(q)) {
      rest.push(item);
    }
  }
  return [...prefix, ...rest];
}

/** Remove the token from the value, collapsing a doubled space. */
export function stripSlashToken(value: string, token: SlashToken): string {
  const before = value.slice(0, token.start);
  const after = value.slice(token.end).replace(/^ /, '');
  return before + after;
}

interface UseSlashCommandsOpts {
  value: string;
  onChange: (next: string) => void;
  items: readonly SlashItem[];
  /** Selection semantics belong to the caller (toggle a skill, run a
   *  command, …). The token is stripped from the value first. */
  onSelect: (item: SlashItem) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function useSlashCommands({ value, onChange, items, onSelect, textareaRef }: UseSlashCommandsOpts) {
  const [highlight, setHighlight] = useState(0);
  // Esc dismisses the menu for THIS token; typing a different token
  // (or moving to a new `/`) re-arms it.
  const dismissedRef = useRef<string | null>(null);

  const caret = textareaRef.current?.selectionStart ?? value.length;
  const token = useMemo(() => slashTokenAt(value, caret), [value, caret]);
  const tokenKey = token ? `${token.start}:${token.query}` : null;
  const filtered = useMemo(
    () => (token ? filterSlashItems(items, token.query) : []),
    [items, token],
  );
  const open = token !== null && filtered.length > 0 && dismissedRef.current !== tokenKey;
  const active = Math.min(highlight, Math.max(0, filtered.length - 1));

  const select = (item: SlashItem) => {
    if (!token) return;
    onChange(stripSlashToken(value, token));
    dismissedRef.current = null;
    setHighlight(0);
    onSelect(item);
    textareaRef.current?.focus();
  };

  /** Run FIRST in the caller's onKeyDown; true = consumed. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % filtered.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const item = filtered[active];
      if (item) select(item);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissedRef.current = tokenKey;
      // Force a re-render so the menu hides immediately.
      setHighlight(0);
      return true;
    }
    return false;
  };

  const menu = open ? (
    <div
      className="absolute bottom-full left-0 right-0 mb-1 z-40 rounded-md border border-[#2a2a35] bg-[#14141c] shadow-xl overflow-hidden"
      role="listbox"
      aria-label="Slash commands"
    >
      {filtered.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === active}
          // Mouse down (not click) so the textarea keeps focus.
          onMouseDown={(e) => {
            e.preventDefault();
            select(item);
          }}
          onMouseEnter={() => setHighlight(i)}
          className={[
            'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors',
            i === active ? 'bg-[#20202c]' : 'bg-transparent',
          ].join(' ')}
        >
          <span className="material-symbols-outlined text-[16px] text-slate-gray shrink-0" aria-hidden>
            {item.icon}
          </span>
          <span className="text-[12px] font-mono text-soft-white shrink-0">/{item.id}</span>
          <span className="text-[11px] text-slate-gray truncate min-w-0 flex-1">
            {item.description}
          </span>
          {item.active !== undefined ? (
            <span
              className={[
                'text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-full border shrink-0',
                item.active
                  ? 'border-[#a4d4a8]/60 text-[#a4d4a8]'
                  : 'border-[#2a2a35] text-slate-gray',
              ].join(' ')}
            >
              {item.active ? 'on' : 'off'}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  ) : null;

  return { open, onKeyDown, menu };
}
