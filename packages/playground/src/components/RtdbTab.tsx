import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useToast } from '@pyric/ui/primitives';
import {
  adminDeleteDatabaseValue,
  adminSetDatabaseValue,
  readDatabaseState,
} from '~/lib/sandbox/runtime';

function normalizePath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function pathSegments(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean);
}

function joinPath(base: string, child: string): string {
  return normalizePath([...pathSegments(base), ...child.split('/').filter(Boolean)].join('/'));
}

function parentPath(path: string): string {
  const segments = pathSegments(path);
  if (segments.length <= 1) return '/';
  return `/${segments.slice(0, -1).join('/')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function childEntries(value: unknown): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
}

function valueAt(root: unknown, path: string): unknown {
  let value = root ?? null;
  for (const segment of pathSegments(path)) {
    if (value === null || typeof value !== 'object') return null;
    value = (value as Record<string, unknown>)[segment] ?? null;
  }
  return value;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function parseJson(value: string): unknown {
  const text = value.trim();
  return text.length === 0 ? null : JSON.parse(text);
}

function valueKind(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function previewValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `${value.length} items`;
  if (isRecord(value)) {
    const count = Object.keys(value).length;
    return count === 1 ? '1 child' : `${count} children`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

export function RtdbTab() {
  const { toast } = useToast();
  const [path, setPath] = useState('/');
  const [snapshot, setSnapshot] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('null');
  const [childKey, setChildKey] = useState('');
  const [childDraft, setChildDraft] = useState('{}');

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void readDatabaseState()
      .then((next) => {
        if (disposed) return;
        setSnapshot(next ?? null);
        setError(null);
      })
      .catch((e) => {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [tick]);

  const selectedValue = useMemo(() => valueAt(snapshot, path), [path, snapshot]);
  const children = useMemo(() => childEntries(selectedValue), [selectedValue]);

  useEffect(() => {
    if (!editing) setDraft(formatJson(selectedValue));
  }, [editing, selectedValue]);

  const refresh = () => setTick((n) => n + 1);

  const saveValue = async () => {
    try {
      await adminSetDatabaseValue(path, parseJson(draft));
      toast({ title: `Saved ${path}`, kind: 'success' });
      setEditing(false);
      refresh();
    } catch (e) {
      toast({
        title: 'Save failed',
        body: e instanceof Error ? e.message : String(e),
        kind: 'error',
      });
    }
  };

  const deleteValue = async () => {
    if (path === '/') return;
    try {
      await adminDeleteDatabaseValue(path);
      toast({ title: `Deleted ${path}`, kind: 'success' });
      setPath(parentPath(path));
      setEditing(false);
      refresh();
    } catch (e) {
      toast({
        title: 'Delete failed',
        body: e instanceof Error ? e.message : String(e),
        kind: 'error',
      });
    }
  };

  const addChild = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = childKey.trim();
    if (!key) return;
    try {
      const nextPath = joinPath(path, key);
      await adminSetDatabaseValue(nextPath, parseJson(childDraft));
      toast({ title: `Added ${nextPath}`, kind: 'success' });
      setChildKey('');
      setChildDraft('{}');
      setPath(nextPath);
      refresh();
    } catch (e) {
      toast({
        title: 'Add child failed',
        body: e instanceof Error ? e.message : String(e),
        kind: 'error',
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-content-bg text-soft-white">
      <RtdbBreadcrumb path={path} onNavigate={(next) => {
        setPath(next);
        setEditing(false);
      }} />
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 min-h-0">
        {error ? (
          <div className="rounded-md border border-[#4a2f34] bg-[#241619] p-3 text-[12px] text-[#ffb4b4]">
            {error}
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(260px,1fr)_minmax(320px,0.9fr)]">
          <section className="grid content-start gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[13px] font-semibold">Children</h3>
                <p className="text-[11px] text-slate-gray">
                  {loading ? 'Loading...' : `${children.length} direct ${children.length === 1 ? 'child' : 'children'}`}
                </p>
              </div>
              {path !== '/' ? (
                <button
                  type="button"
                  onClick={() => setPath(parentPath(path))}
                  className="rounded border border-[#2a2a35] px-2.5 py-1 text-[11px] text-slate-gray hover:text-soft-white hover:border-[#3a3a48]"
                >
                  Back
                </button>
              ) : null}
            </div>

            {children.length > 0 ? (
              <div className="overflow-hidden rounded-md border border-[#2a2a35] bg-[#17171d]">
                {children.map(([key, value]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setPath(joinPath(path, key));
                      setEditing(false);
                    }}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#2a2a35] px-3 py-3 text-left last:border-b-0 hover:bg-[#20202c]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[13px] text-soft-white">
                        {key}
                      </span>
                      <span className="block truncate text-[11px] text-slate-gray">
                        {previewValue(value)}
                      </span>
                    </span>
                    <span className="rounded-full border border-[#2a2a35] px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-gray">
                      {valueKind(value)}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-[#2a2a35] bg-[#17171d] p-4 text-[12px] text-slate-gray">
                {path === '/' ? 'Database is empty. Add a child node to seed RTDB data.' : 'No child nodes at this path.'}
              </div>
            )}

            <form onSubmit={addChild} className="grid gap-2 rounded-md border border-[#2a2a35] bg-[#17171d] p-3">
              <div>
                <label className="font-mono text-[10px] uppercase tracking-wide text-slate-gray" htmlFor="rtdb-child-key">
                  Add child
                </label>
                <input
                  id="rtdb-child-key"
                  value={childKey}
                  onChange={(event) => setChildKey(event.target.value)}
                  placeholder="childKey"
                  className="mt-1 w-full rounded border border-[#2a2a35] bg-content-bg px-2.5 py-1.5 font-mono text-[12px] text-soft-white placeholder:text-slate-gray/60 focus:outline-none focus:border-slate-gray"
                />
              </div>
              <textarea
                value={childDraft}
                onChange={(event) => setChildDraft(event.target.value)}
                rows={5}
                spellCheck={false}
                className="w-full resize-y rounded border border-[#2a2a35] bg-content-bg px-2.5 py-2 font-mono text-[12px] leading-relaxed text-soft-white focus:outline-none focus:border-slate-gray"
              />
              <button
                type="submit"
                disabled={childKey.trim().length === 0}
                className="justify-self-start rounded border border-[#2a2a35] px-3 py-1.5 text-[11px] text-soft-white hover:border-[#3a3a48] disabled:cursor-not-allowed disabled:text-slate-gray/50"
              >
                Add child
              </button>
            </form>
          </section>

          <section className="grid content-start gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate font-mono text-[13px] text-soft-white">{path}</h3>
                <p className="text-[11px] text-slate-gray">{valueKind(selectedValue)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {editing ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(false);
                        setDraft(formatJson(selectedValue));
                      }}
                      className="rounded border border-[#2a2a35] px-2.5 py-1 text-[11px] text-slate-gray hover:text-soft-white"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void saveValue()}
                      className="rounded border border-[#a4d4a8]/50 bg-[#14201a] px-2.5 py-1 text-[11px] text-[#a4d4a8]"
                    >
                      Save
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="rounded border border-[#2a2a35] px-2.5 py-1 text-[11px] text-soft-white hover:border-[#3a3a48]"
                  >
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  disabled={path === '/'}
                  onClick={() => void deleteValue()}
                  className="rounded border border-[#4a2f34] px-2.5 py-1 text-[11px] text-[#ff8f8f] hover:bg-[#241619] disabled:cursor-not-allowed disabled:text-slate-gray/40"
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
                className="min-h-[320px] w-full resize-y rounded-md border border-[#2a2a35] bg-[#111116] p-3 font-mono text-[12px] leading-relaxed text-soft-white focus:outline-none focus:border-slate-gray"
              />
            ) : (
              <pre className="min-h-[320px] overflow-auto rounded-md border border-[#2a2a35] bg-[#111116] p-3 font-mono text-[12px] leading-relaxed text-soft-white custom-scrollbar">
                {formatJson(selectedValue)}
              </pre>
            )}
          </section>
        </div>
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
  const segments = pathSegments(path);
  return (
    <div className="shrink-0 border-b border-[#2a2a35] px-4 py-3 font-mono text-[12px]">
      <button
        type="button"
        onClick={() => onNavigate('/')}
        className="text-slate-gray hover:text-soft-white"
      >
        /
      </button>
      {segments.length === 0 ? (
        <span className="ml-2 text-soft-white">root</span>
      ) : (
        segments.map((segment, index) => {
          const nextPath = `/${segments.slice(0, index + 1).join('/')}`;
          const active = index === segments.length - 1;
          return (
            <span key={nextPath} className="text-slate-gray">
              <span className="mx-2">/</span>
              <button
                type="button"
                disabled={active}
                onClick={() => onNavigate(nextPath)}
                className={active ? 'text-soft-white' : 'hover:text-soft-white'}
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
