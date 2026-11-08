import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { RtdbApi } from '../rtdbApi.js';
import type { RtdbTreeController } from '../hooks/useRtdbTree.js';
import {
  RTDB_EDITOR_TYPES,
  coerceRtdbEditorValue,
  formatRtdbEditorValue,
  inferRtdbEditorType,
  rtdbKeyInputError,
  type RtdbEditorType,
} from '../editor.js';
import {
  formatRtdbValueLabel,
  hasRtdbChildren,
  joinRtdbPath,
  rtdbPathSegments,
  rtdbValueKind,
} from '../values.js';

export interface RtdbTreeProps {
  /** The live tree controller from `useRtdbTree`. */
  tree: RtdbTreeController;
  /** Mutation backend (admin lens in Studio). */
  api: RtdbApi;
  /** Key-click navigation: re-roots the viewer at the clicked node (wire to
   *  the same path state as the path bar). */
  onNavigate?: (path: string) => void;
  /** Label for the view-root row when the root is `'/'` — the database /
   *  instance identity. Default `'/'`. */
  rootLabel?: ReactNode;
  className?: string;
}

/**
 * The RTDB data tree — the interaction form of the Firebase console /
 * firebase-tools-ui database viewer (clean-room adaptation of the
 * NodeContainer/NodeParent/NodeLeaf split):
 *
 * - parents render a caret (expand/collapse), leaves a `key: value` row;
 * - keys navigate (re-root the view), carets only toggle;
 * - hover/focus reveals per-node actions: `+` add child, `×` delete —
 *   delete flips to an INLINE two-step confirm (no modal, C3);
 * - leaf values are click-to-edit inline (type select: string / number /
 *   boolean / JSON);
 * - wide levels page at `tree.pageSize` with a "show more" row (the console's
 *   form — see `reducers/tree.ts` for why paging over virtualization).
 *
 * Headless: consumers style `[data-pyric-ui="rtdb-tree"]` and the
 * `data-rtdb-*` attributes (`node`, `row`, `caret`, `key`, `sep`, `value`,
 * `actions`, `action-add`, `action-delete`, `confirm`, `editor`, `children`,
 * `show-more`, `error`, `loading`). An empty root renders the console's
 * classic form — `<root>: null` — not an instructional empty state.
 */
export function RtdbTree({ tree, api, onNavigate, rootLabel = '/', className }: RtdbTreeProps) {
  const { state } = tree;
  const rootSegments = rtdbPathSegments(state.path);
  const rootKey: ReactNode =
    rootSegments.length === 0 ? rootLabel : rootSegments[rootSegments.length - 1];

  return (
    <div className={className} data-pyric-ui="rtdb-tree">
      {state.status === 'loading' ? (
        <p data-rtdb-loading>Loading…</p>
      ) : state.status === 'error' ? (
        <p role="alert" data-rtdb-error>
          {state.error}
        </p>
      ) : (
        <Node
          tree={tree}
          api={api}
          onNavigate={onNavigate}
          path={state.path}
          label={rootKey}
          isViewRoot
        />
      )}
    </div>
  );
}

interface NodeProps {
  tree: RtdbTreeController;
  api: RtdbApi;
  onNavigate?: (path: string) => void;
  /** Absolute database path of this node. */
  path: string;
  /** The key text (or the root label node for the view root at `'/'`). */
  label: ReactNode;
  isViewRoot?: boolean;
}

function Node({ tree, api, onNavigate, path, label, isViewRoot }: NodeProps) {
  const value = tree.valueAt(path);
  const isParent = hasRtdbChildren(value);
  const expanded = tree.isExpanded(path);
  const update = tree.updateAt(path);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = async (op: () => Promise<void>, done: () => void) => {
    try {
      await op();
      setActionError(null);
      done();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const openAdd = () => {
    setAdding(true);
    setConfirming(false);
    if (isParent && !expanded) tree.toggle(path);
  };

  const children = isParent && expanded ? tree.childrenAt(path) : null;

  return (
    <div
      data-rtdb-node
      data-rtdb-kind={isParent ? 'parent' : 'leaf'}
      data-rtdb-view-root={isViewRoot ? '' : undefined}
      data-rtdb-expanded={isParent && expanded ? '' : undefined}
    >
      <div
        data-rtdb-row
        data-pyric-update={update?.kind}
        data-pyric-update-cycle={update?.cycle}
      >
        {isParent && !isViewRoot ? (
          <button
            type="button"
            data-rtdb-caret
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            onClick={() => tree.toggle(path)}
          >
            <svg aria-hidden viewBox="0 0 8 8" width="8" height="8" fill="currentColor">
              <path d="M1 0l6 4-6 4z" />
            </svg>
          </button>
        ) : (
          <span aria-hidden data-rtdb-caret-spacer />
        )}

        <button
          type="button"
          data-rtdb-key
          aria-label="Key name"
          onClick={() => onNavigate?.(path)}
        >
          {label}
        </button>

        {!isParent ? (
          <>
            <span aria-hidden data-rtdb-sep>
              :
            </span>
            <button
              type="button"
              data-rtdb-value
              data-rtdb-type={rtdbValueKind(value)}
              title="Edit value"
              onClick={() => {
                setEditing(true);
                setConfirming(false);
              }}
            >
              {formatRtdbValueLabel(value)}
            </button>
          </>
        ) : null}

        <span data-rtdb-actions>
          {confirming ? (
            <span data-rtdb-confirm>
              <span data-rtdb-confirm-label>Delete{isParent ? ' subtree' : ''}?</span>
              <button
                type="button"
                data-rtdb-confirm-yes
                onClick={() =>
                  void run(
                    () => api.remove(path),
                    () => setConfirming(false),
                  )
                }
              >
                Delete
              </button>
              <button type="button" data-rtdb-confirm-no onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <>
              <button
                type="button"
                data-rtdb-action-add
                aria-label={`Add child to ${pathLabel(path)}`}
                title="Add child"
                onClick={openAdd}
              >
                +
              </button>
              <button
                type="button"
                data-rtdb-action-delete
                aria-label={`Delete ${pathLabel(path)}`}
                title="Delete"
                onClick={() => setConfirming(true)}
              >
                ×
              </button>
            </>
          )}
        </span>
      </div>

      {actionError ? (
        <p role="alert" data-rtdb-error>
          {actionError}
        </p>
      ) : null}

      {editing ? (
        <ValueEditor
          initialType={inferRtdbEditorType(value)}
          initialText={formatRtdbEditorValue(value, inferRtdbEditorType(value))}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={(next) =>
            run(
              () => api.set(path, next),
              () => setEditing(false),
            )
          }
        />
      ) : null}

      {adding ? (
        <ValueEditor
          withKey
          initialType="string"
          initialText=""
          submitLabel="Add"
          onCancel={() => setAdding(false)}
          onSubmit={(next, key) =>
            run(
              () => api.set(joinRtdbPath(path, key!), next),
              () => setAdding(false),
            )
          }
        />
      ) : null}

      {children ? (
        <ul data-rtdb-children>
          {children.entries.map(([key]) => (
            <li key={key}>
              <Node
                tree={tree}
                api={api}
                onNavigate={onNavigate}
                path={joinRtdbPath(path, key)}
                label={key}
              />
            </li>
          ))}
          {children.hiddenCount > 0 ? (
            <li data-rtdb-show-more-item>
              <button type="button" data-rtdb-show-more onClick={() => tree.showMore(path)}>
                Show more ({children.hiddenCount} hidden)
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** Last segment for aria labels; `'/'` reads as "root". */
function pathLabel(path: string): string {
  const segments = rtdbPathSegments(path);
  return segments.length === 0 ? 'root' : segments[segments.length - 1];
}

interface ValueEditorProps {
  /** Add mode: include the child-key input. */
  withKey?: boolean;
  initialType: RtdbEditorType;
  initialText: string;
  submitLabel: string;
  onSubmit: (value: unknown, key?: string) => Promise<void> | void;
  onCancel: () => void;
}

/**
 * Inline key/value editor row (add + edit flows). Escape cancels.
 *
 * The key + value fields are UNCONTROLLED and read at submit — validation
 * happens on submit (errors render inline), so per-keystroke state buys
 * nothing. Only the type select is controlled (it decides whether the value
 * control is a text input or a true/false select).
 */
function ValueEditor({
  withKey,
  initialType,
  initialText,
  submitLabel,
  onSubmit,
  onCancel,
}: ValueEditorProps) {
  const keyRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
  const [type, setType] = useState<RtdbEditorType>(initialType);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const key = keyRef.current?.value ?? '';
    if (withKey) {
      const keyError = rtdbKeyInputError(key);
      if (keyError) {
        setError(keyError);
        return;
      }
    }
    const coerced = coerceRtdbEditorValue(type, valueRef.current?.value ?? '');
    if (!coerced.ok) {
      setError(coerced.error);
      return;
    }
    setError(null);
    void onSubmit(coerced.value, withKey ? key.trim() : undefined);
  };

  const onEscape = (e: { key: string }) => {
    if (e.key === 'Escape') onCancel();
  };

  return (
    <form data-rtdb-editor onSubmit={submit}>
      {withKey ? (
        <input
          ref={keyRef}
          data-rtdb-editor-key
          aria-label="Child key"
          placeholder="key"
          autoFocus
          onKeyDown={onEscape}
          spellCheck={false}
        />
      ) : null}
      <select
        data-rtdb-editor-type
        aria-label="Value type"
        value={type}
        onChange={(e) => setType(e.currentTarget.value as RtdbEditorType)}
        onKeyDown={onEscape}
      >
        {RTDB_EDITOR_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {type === 'boolean' ? (
        <select
          ref={valueRef as { current: HTMLSelectElement | null }}
          data-rtdb-editor-value
          aria-label="Value"
          defaultValue={initialText.trim().toLowerCase() === 'true' ? 'true' : 'false'}
          onKeyDown={onEscape}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          ref={valueRef as { current: HTMLInputElement | null }}
          data-rtdb-editor-value
          aria-label="Value"
          placeholder={type === 'json' ? '{ "key": "value" }' : 'value'}
          autoFocus={!withKey}
          defaultValue={initialText}
          onKeyDown={onEscape}
          spellCheck={false}
        />
      )}
      <button type="submit" data-rtdb-editor-save>
        {submitLabel}
      </button>
      <button type="button" data-rtdb-editor-cancel onClick={onCancel}>
        Cancel
      </button>
      {error ? (
        <span role="alert" data-rtdb-editor-error>
          {error}
        </span>
      ) : null}
    </form>
  );
}
