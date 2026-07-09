import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { parseRtdbPathInput, rtdbCrumbs } from '../pathInput.js';
import { normalizeRtdbPath } from '../values.js';

export interface RtdbPathBarProps {
  /** Current absolute database path (`'/'` for root). */
  path: string;
  /** Fired with the parsed absolute path on crumb click or input submit. */
  onNavigate: (path: string) => void;
  /** Root crumb label — the database/instance identity (e.g. the sandbox
   *  slug). Default `'/'`. */
  rootLabel?: ReactNode;
  /** Text shown before the input while editing (the non-editable URL part). */
  inputPrefix?: string;
  className?: string;
}

/**
 * The editable path bar of the RTDB viewer — the interaction form of the
 * Firebase console / firebase-tools-ui database URL bar (clean-room
 * adaptation): in DISPLAY mode the path renders as clickable crumbs
 * (root → … → current) plus an edit affordance; EDIT mode swaps in a text
 * input seeded with the current path — Enter navigates, Escape or blur
 * cancels. Pasted full URLs and missing leading slashes are tolerated
 * (`parseRtdbPathInput`).
 *
 * Headless. Consumers style via:
 * - `[data-pyric-ui="rtdb-path-bar"]` — the root (`data-rtdb-editing` when editing)
 * - `[data-rtdb-crumb]` / `[data-rtdb-crumb-root]` / `[data-pyric-current]`
 * - `[data-rtdb-crumb-separator]`
 * - `[data-rtdb-path-edit]` — the edit button
 * - `[data-rtdb-path-form]`, `[data-rtdb-path-prefix]`, `[data-rtdb-path-input]`
 */
export function RtdbPathBar({
  path,
  onNavigate,
  rootLabel = '/',
  inputPrefix,
  className,
}: RtdbPathBarProps) {
  const normalized = normalizeRtdbPath(path);
  const [editing, setEditing] = useState(false);
  // UNCONTROLLED input, read at submit: the input mounts fresh per edit
  // session (display mode unmounts it) seeded with the current path, so a
  // cancelled draft never leaks into the next session.
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onNavigate(parseRtdbPathInput(inputRef.current?.value ?? ''));
    setEditing(false);
  };

  const cancel = () => setEditing(false);

  const crumbs = rtdbCrumbs(normalized);

  return (
    <nav
      className={className}
      data-pyric-ui="rtdb-path-bar"
      data-rtdb-editing={editing ? '' : undefined}
      aria-label="Database path"
    >
      {editing ? (
        <form data-rtdb-path-form onSubmit={submit}>
          {inputPrefix ? <span data-rtdb-path-prefix>{inputPrefix}</span> : null}
          <input
            ref={inputRef}
            data-rtdb-path-input
            aria-label="Database path"
            autoFocus
            defaultValue={normalized}
            onBlur={cancel}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel();
            }}
            spellCheck={false}
          />
        </form>
      ) : (
        <>
          <ol data-rtdb-crumb-list>
            <li data-rtdb-crumb-item>
              <button
                type="button"
                data-rtdb-crumb
                data-rtdb-crumb-root
                data-pyric-current={crumbs.length === 0 ? '' : undefined}
                aria-current={crumbs.length === 0 ? 'page' : undefined}
                onClick={() => onNavigate('/')}
              >
                {rootLabel}
              </button>
            </li>
            {crumbs.map((crumb, i) => {
              const isCurrent = i === crumbs.length - 1;
              return (
                <li key={crumb.path} data-rtdb-crumb-item>
                  <span aria-hidden data-rtdb-crumb-separator>
                    /
                  </span>
                  <button
                    type="button"
                    data-rtdb-crumb
                    data-pyric-current={isCurrent ? '' : undefined}
                    aria-current={isCurrent ? 'page' : undefined}
                    onClick={() => onNavigate(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            data-rtdb-path-edit
            aria-label="Edit path"
            title="Edit path"
            onClick={() => setEditing(true)}
          >
            <svg aria-hidden viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
              <path d="M11.7 1.3a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4l-8.5 8.5-3.4 1.1a.5.5 0 0 1-.63-.63l1.1-3.4 8.43-8.57ZM10.9 3.5l1.6 1.6 1.2-1.2-1.6-1.6-1.2 1.2Z" />
            </svg>
          </button>
        </>
      )}
    </nav>
  );
}
