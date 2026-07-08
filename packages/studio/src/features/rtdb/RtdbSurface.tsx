import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  formatRtdbJson,
  joinRtdbPath,
  parentRtdbPath,
  parseRtdbJson,
  previewRtdbValue,
  rtdbChildEntries,
  rtdbPathSegments,
  rtdbValueAt,
  rtdbValueKind,
} from '@pyric/ui/rtdb';
import { useEnvironment } from '../../shell/environment.js';
import type { WorkerLivePlane } from '../../clients/worker-live.js';

export function RtdbSurface() {
  const env = useEnvironment();
  const live = env.status === 'ready' ? env.env.live : undefined;

  return (
    <section className="studio-surface grid gap-4" aria-labelledby="rtdb-title">
      <div className="studio-surface__intro">
        <p className="studio-surface__eyebrow">RTDB</p>
        <h1 id="rtdb-title" className="studio-surface__title">
          RTDB
        </h1>
        <p className="studio-surface__copy">Browse and edit RTDB data in the shared sandbox.</p>
      </div>

      {live ? <LiveRtdbBrowser live={live} /> : <RtdbPending />}
    </section>
  );
}

function RtdbPending() {
  return (
    <div className="rounded-md border border-dashed border-line bg-panel p-8 text-center">
      <span className="rounded-full border border-line px-3 py-1 text-xs uppercase tracking-wide text-muted">
        Shared worker pending
      </span>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
        The RTDB browser goes live once Studio connects to the shared sandbox worker.
      </p>
    </div>
  );
}

function LiveRtdbBrowser({ live }: { live: WorkerLivePlane }) {
  const [path, setPath] = useState('/');
  const [snapshot, setSnapshot] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('null');
  const [childKey, setChildKey] = useState('');
  const [childDraft, setChildDraft] = useState('{}');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await live.readRtdbState());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [live]);

  useEffect(() => {
    void refresh();
    return live.feed.subscribe(() => {
      void refresh();
    });
  }, [live, refresh]);

  const selectedValue = useMemo(() => rtdbValueAt(snapshot, path), [path, snapshot]);
  const children = useMemo(() => rtdbChildEntries(selectedValue), [selectedValue]);

  useEffect(() => {
    if (!editing) setDraft(formatRtdbJson(selectedValue));
  }, [editing, selectedValue]);

  const navigate = (nextPath: string) => {
    setPath(nextPath);
    setEditing(false);
    setMessage(null);
    setError(null);
  };

  const saveValue = async () => {
    try {
      await live.setRtdbValue(path, parseRtdbJson(draft));
      setMessage(`Saved ${path}`);
      setError(null);
      setEditing(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteValue = async () => {
    if (path === '/') return;
    try {
      await live.deleteRtdbValue(path);
      setMessage(`Deleted ${path}`);
      setError(null);
      setPath(parentRtdbPath(path));
      setEditing(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addChild = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = childKey.trim();
    if (!key) return;
    try {
      const nextPath = joinRtdbPath(path, key);
      await live.setRtdbValue(nextPath, parseRtdbJson(childDraft));
      setMessage(`Added ${nextPath}`);
      setError(null);
      setChildKey('');
      setChildDraft('{}');
      setPath(nextPath);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="grid min-h-[560px] overflow-hidden rounded-md border border-line bg-panel">
      <RtdbBreadcrumb path={path} onNavigate={navigate} />

      {(error || message) ? (
        <div
          className={[
            'border-b px-4 py-2 text-sm',
            error
              ? 'border-deny/40 bg-deny-tint text-deny-ink'
              : 'border-line bg-elevated text-muted',
          ].join(' ')}
        >
          {error ?? message}
        </div>
      ) : null}

      <div className="grid min-h-0 gap-4 p-4 lg:grid-cols-[minmax(260px,1fr)_minmax(320px,0.9fr)]">
        <section className="grid min-h-0 content-start gap-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="m-0 text-sm font-semibold text-ink">Children</h2>
              <p className="m-0 text-xs text-muted">
                {loading
                  ? 'Loading...'
                  : `${children.length} direct ${children.length === 1 ? 'child' : 'children'}`}
              </p>
            </div>
            {path !== '/' ? (
              <button type="button" className="studio-button" onClick={() => navigate(parentRtdbPath(path))}>
                Back
              </button>
            ) : null}
          </div>

          {children.length > 0 ? (
            <div className="overflow-hidden rounded-md border border-line bg-bg">
              {children.map(([key, value]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => navigate(joinRtdbPath(path, key))}
                  className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line bg-transparent px-3 py-3 text-left last:border-b-0 hover:bg-elevated"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-sm text-ink">{key}</span>
                    <span className="block truncate text-xs text-muted">{previewRtdbValue(value)}</span>
                  </span>
                  <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted">
                    {rtdbValueKind(value)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-line bg-bg p-4 text-sm text-muted">
              {path === '/' ? 'Database is empty. Add a child node to seed RTDB data.' : 'No child nodes at this path.'}
            </div>
          )}

          <form onSubmit={addChild} className="grid gap-2 rounded-md border border-line bg-bg p-3">
            <div>
              <label className="font-mono text-[10px] uppercase tracking-wide text-muted" htmlFor="studio-rtdb-child-key">
                Add child
              </label>
              <input
                id="studio-rtdb-child-key"
                value={childKey}
                onChange={(event) => setChildKey(event.target.value)}
                placeholder="childKey"
                className="mt-1 w-full rounded border border-line bg-panel px-2.5 py-1.5 font-mono text-sm text-ink placeholder:text-faint focus:border-line-2 focus:outline-none"
              />
            </div>
            <textarea
              value={childDraft}
              onChange={(event) => setChildDraft(event.target.value)}
              rows={5}
              spellCheck={false}
              className="w-full resize-y rounded border border-line bg-panel px-2.5 py-2 font-mono text-sm leading-relaxed text-ink focus:border-line-2 focus:outline-none"
            />
            <button
              type="submit"
              disabled={childKey.trim().length === 0}
              className="studio-button justify-self-start"
            >
              Add child
            </button>
          </form>
        </section>

        <section className="grid min-h-0 content-start gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="m-0 truncate font-mono text-sm text-ink">{path}</h2>
              <p className="m-0 text-xs text-muted">{rtdbValueKind(selectedValue)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {editing ? (
                <>
                  <button
                    type="button"
                    className="studio-button"
                    onClick={() => {
                      setEditing(false);
                      setDraft(formatRtdbJson(selectedValue));
                    }}
                  >
                    Cancel
                  </button>
                  <button type="button" className="studio-button studio-button--primary" onClick={() => void saveValue()}>
                    Save
                  </button>
                </>
              ) : (
                <button type="button" className="studio-button" onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
              <button
                type="button"
                disabled={path === '/'}
                className="studio-button studio-button--danger"
                onClick={() => void deleteValue()}
              >
                Delete
              </button>
            </div>
          </div>

          {editing ? (
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={18}
              spellCheck={false}
              className="min-h-[320px] w-full resize-y rounded-md border border-line bg-bg p-3 font-mono text-sm leading-relaxed text-ink focus:border-line-2 focus:outline-none"
            />
          ) : (
            <pre className="min-h-[320px] overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-sm leading-relaxed text-ink">
              {formatRtdbJson(selectedValue)}
            </pre>
          )}
        </section>
      </div>
    </div>
  );
}

function RtdbBreadcrumb({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const segments = rtdbPathSegments(path);
  return (
    <div className="border-b border-line px-4 py-3 font-mono text-sm">
      <button type="button" onClick={() => onNavigate('/')} className="text-muted hover:text-ink">
        /
      </button>
      {segments.length === 0 ? (
        <span className="ml-2 text-ink">root</span>
      ) : (
        segments.map((segment, index) => {
          const nextPath = `/${segments.slice(0, index + 1).join('/')}`;
          const active = index === segments.length - 1;
          return (
            <span key={nextPath} className="text-muted">
              <span className="mx-2">/</span>
              <button
                type="button"
                disabled={active}
                onClick={() => onNavigate(nextPath)}
                className={active ? 'text-ink' : 'hover:text-ink'}
              >
                {segment}
              </button>
            </span>
          );
        })
      )}
    </div>
  );
}
