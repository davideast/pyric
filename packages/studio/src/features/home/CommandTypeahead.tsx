/**
 * The command typeahead — ONE implementation, two mounts:
 *
 *   1. Home's inline command input (the hub's primary action).
 *   2. The shell's global ⌘K overlay on every other tab.
 *
 * Deterministic router over tabs + deep-link patterns + the lazily built
 * resource index (`useResourceIndex`); results are actions/routes only (M4).
 * The two mounts differ only in chrome and in what Escape / a selection do —
 * both flow through the props here, so the matcher, index, grouping, and
 * keyboard model can never drift apart.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ROUTES } from '../../shell/routes.js';
import { pushPath } from '../../shell/router.js';
import type { CommandResult, CommandTarget } from './command.js';
import { flattenSuggestions, matchTypeahead } from './typeahead.js';
import { useResourceIndex } from './useResourceIndex.js';

const TYPEAHEAD_DEBOUNCE_MS = 150;

/** Input that looks RTDB-directed — the one signal worth a full-tree RTDB
 *  read on index refresh (see useResourceIndex's tradeoff note). */
function looksRtdbish(input: string): boolean {
  return input.startsWith('/') || /rtdb/i.test(input);
}

export interface CommandTypeaheadProps {
  /** Focus the input on mount (the overlay mount). */
  autoFocus?: boolean;
  /** Called after a selection navigated (the overlay closes on it). */
  onNavigated?: (target: CommandTarget) => void;
  /** Escape handler. When absent, Escape clears the input (inline mount);
   *  the overlay passes its close. */
  onEscape?: () => void;
  /** Mount-scoped registration of a "focus me" handle (⌘K on Home focuses
   *  the inline input instead of opening the overlay). Called with the focus
   *  fn on mount and `null` on unmount. */
  exposeFocus?: (focus: (() => void) | null) => void;
}

export function CommandTypeahead({
  autoFocus,
  onNavigated,
  onEscape,
  exposeFocus,
}: CommandTypeaheadProps) {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { entries, building, ensure } = useResourceIndex();

  useEffect(() => {
    if (!exposeFocus) return;
    exposeFocus(() => inputRef.current?.focus());
    return () => exposeFocus(null);
  }, [exposeFocus]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // 150ms debounce: the matcher runs against `query`, not each keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(input), TYPEAHEAD_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input]);

  const groups = useMemo(
    () => matchTypeahead(query, ROUTES, entries ?? []),
    [query, entries],
  );
  const flat = useMemo(() => flattenSuggestions(groups), [groups]);

  // Keep the keyboard cursor on a real row as the result set changes.
  useEffect(() => {
    setActive((cur) => (flat.length === 0 ? 0 : Math.min(cur, flat.length - 1)));
  }, [flat.length]);

  const run = (result: CommandResult | undefined) => {
    if (!result) return;
    setInput('');
    setQuery('');
    setOpen(false);
    pushPath(result.target);
    onNavigated?.(result.target);
  };

  // Enter must act on what the user SEES TYPED, not the debounced snapshot:
  // if the debounce hasn't committed yet, recompute against the current input
  // and take its top hit (the stale `active` index has no meaning there).
  const commit = () => {
    if (input === query) {
      run(flat[active] ?? flat[0]);
      return;
    }
    const fresh = flattenSuggestions(matchTypeahead(input, ROUTES, entries ?? []));
    run(fresh[0]);
  };

  // Group-relative → flat index (for the active-row highlight).
  let flatOffset = 0;

  return (
    <div className="studio-home__command">
      <div className="studio-home__command-row">
        <input
          ref={inputRef}
          className="studio-home__command-input"
          type="text"
          value={input}
          placeholder="Jump to a surface, collection, doc, user, or object…"
          aria-label="Command input"
          role="combobox"
          aria-expanded={open && flat.length > 0}
          aria-autocomplete="list"
          onFocus={() => {
            ensure();
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            const next = e.target.value;
            setInput(next);
            setOpen(true);
            if (looksRtdbish(next)) ensure({ rtdbLikely: true });
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((cur) => Math.min(cur + 1, Math.max(flat.length - 1, 0)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((cur) => Math.max(cur - 1, 0));
            } else if (e.key === 'Enter') {
              commit();
            } else if (e.key === 'Escape') {
              if (onEscape) {
                onEscape();
                return;
              }
              setInput('');
              setQuery('');
              setOpen(false);
            }
          }}
        />
      </div>
      {open && !groups.length && building && entries === null ? (
        // No matches YET because the first-ever build hasn't landed a single
        // batch (entries is still null) — a cheap, non-interactive signal so
        // a fast typer doesn't see dead air while the index is still
        // resolving (see `useResourceIndex`'s progressive publication).
        // Once any batch lands, `entries` flips off null and the real
        // results box below takes over.
        <div className="studio-home__command-results" role="status" aria-live="polite">
          <span className="studio-home__command-group-title">Indexing sandbox…</span>
        </div>
      ) : null}
      {open && groups.length ? (
        <div
          className="studio-home__command-results"
          role="listbox"
          aria-label="Suggestions"
          // Keep focus in the input so onBlur doesn't close the listbox
          // before a suggestion's click handler fires.
          onMouseDown={(e) => e.preventDefault()}
        >
          {groups.map((group) => {
            const start = flatOffset;
            flatOffset += group.results.length;
            return (
              <div key={group.kind} className="studio-home__command-group">
                <span className="studio-home__command-group-title" aria-hidden="true">
                  {group.title}
                </span>
                <ul className="studio-home__command-group-list">
                  {group.results.map((r, i) => {
                    const flatIndex = start + i;
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={flatIndex === active}
                          className="studio-home__command-result"
                          data-active={flatIndex === active ? 'true' : undefined}
                          onMouseEnter={() => setActive(flatIndex)}
                          onClick={() => run(r)}
                        >
                          <span className="studio-home__command-label">{r.label}</span>
                          <span className="studio-home__command-sub">{r.hint}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
