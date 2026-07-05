/**
 * ⌘K palette: a prompt box with deterministic actions alongside it.
 *
 * The box IS the prompt: you describe a change and Enter runs it (the agent
 * stages it for review, or applies it directly per the governance mode). It is
 * not a search field that secretly turns prose into a command. Deterministic
 * actions (jump to a surface, open settings) live in the list below and are
 * filtered as you type; arrow to one and Enter runs it instead.
 *
 * When there is text, the primary row reflects what you typed (run it). With no
 * text, the palette is a plain launcher of the deterministic actions.
 *
 * Dependency-free: a backdrop + a centered panel, Esc to close, up/down to move,
 * Enter to choose. Token-styled via `styles/index.css` (`.studio__palette*`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ROUTES } from './routes.js';

interface PaletteAction {
  id: string;
  label: string;
  blurb: string;
  run: () => void;
}

export function CommandPalette({
  open,
  active,
  onClose,
  onNavigate,
  onRunPrompt,
  onOpenSettings,
  runBlurb,
}: {
  open: boolean;
  active: string;
  onClose: () => void;
  onNavigate: (id: string) => void;
  /** Run a natural-language change (the prompt). Resolves when staged (the
   *  caller navigates); rejects with a message the palette surfaces. */
  onRunPrompt?: (prompt: string) => Promise<void>;
  /** Open the settings modal (a deterministic action). */
  onOpenSettings?: () => void;
  /** What Enter does to the prompt, e.g. "Runs on a copy for review". */
  runBlurb?: string;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Deterministic actions: jump to a surface, open settings. No agent involved.
  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = ROUTES.filter((r) => !r.hidden).map((r) => ({
      id: `nav:${r.id}`,
      label: r.label,
      blurb: r.blurb,
      run: () => {
        onNavigate(r.id);
        onClose();
      },
    }));
    if (onOpenSettings) {
      list.push({
        id: 'settings',
        label: 'Settings',
        blurb: 'API keys + model',
        run: () => {
          onOpenSettings();
          onClose();
        },
      });
    }
    return list;
  }, [onNavigate, onOpenSettings, onClose]);

  const prompt = query.trim();
  const needle = prompt.toLowerCase();
  const matching = useMemo(
    () =>
      needle
        ? actions.filter(
            (a) =>
              a.label.toLowerCase().includes(needle) ||
              a.blurb.toLowerCase().includes(needle) ||
              a.id.includes(needle),
          )
        : actions,
    [actions, needle],
  );

  const canRun = !!onRunPrompt && prompt.length > 0;
  // Items the cursor walks: the run row (when there's text) first, then actions.
  const items = canRun
    ? [{ kind: 'run' as const }, ...matching.map((a) => ({ kind: 'action' as const, action: a }))]
    : matching.map((a) => ({ kind: 'action' as const, action: a }));

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    setRunning(false);
    setError(null);
    inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const runPrompt = async () => {
    if (!canRun || !onRunPrompt || running) return;
    setRunning(true);
    setError(null);
    try {
      await onRunPrompt(prompt);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  };

  const choose = (index: number) => {
    const it = items[index];
    if (!it) return;
    if (it.kind === 'run') void runPrompt();
    else it.action.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (running) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(cursor);
    }
  };

  const clamped = Math.min(cursor, Math.max(items.length - 1, 0));

  return (
    <div className="studio__palette-backdrop" onMouseDown={onClose}>
      <div
        className="studio__palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="studio__palette-cmd">
          <span className="studio__caret" />
          <input
            ref={inputRef}
            className="studio__palette-input"
            type="text"
            placeholder="Describe a change, or jump to a surface…"
            value={query}
            disabled={running}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
              setError(null);
            }}
            onKeyDown={onKeyDown}
            aria-label="Describe a change, or jump to a surface"
          />
          <span className="studio__kbd">esc</span>
        </div>

        {running ? (
          <p className="studio__palette-running">Staging your change…</p>
        ) : (
          <ul className="studio__palette-list">
            {items.map((it, i) =>
              it.kind === 'run' ? (
                <li key="run">
                  <button
                    type="button"
                    className="studio__palette-item studio__palette-run"
                    data-active={i === clamped ? '' : undefined}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => void runPrompt()}
                  >
                    <span className="studio__palette-label">{prompt}</span>
                    <span className="studio__palette-blurb">{runBlurb ?? 'Run this change'}</span>
                  </button>
                </li>
              ) : (
                <li key={it.action.id}>
                  <button
                    type="button"
                    className="studio__palette-item"
                    data-active={i === clamped ? '' : undefined}
                    aria-current={it.action.id === `nav:${active}` ? 'page' : undefined}
                    onMouseEnter={() => setCursor(i)}
                    onClick={it.action.run}
                  >
                    <span className="studio__palette-label">{it.action.label}</span>
                    <span className="studio__palette-blurb">{it.action.blurb}</span>
                  </button>
                </li>
              ),
            )}
            {items.length === 0 ? (
              <li className="studio__palette-empty">No matching action.</li>
            ) : null}
          </ul>
        )}

        {error ? <p className="studio__palette-error">{error}</p> : null}
      </div>
    </div>
  );
}
