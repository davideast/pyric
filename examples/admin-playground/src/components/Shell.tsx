import { useEffect, useState } from 'react';
import { ConfirmProvider, ToastProvider } from '@pyric/ui/primitives';
import { SECTIONS, findEntry, type ShowcaseEntry } from '~/showcases/registry';

/**
 * Top-level shell — sidebar nav (per-section grouping) + the active
 * showcase. Hash-based routing so deep links survive reload without
 * needing Astro file-routing per component.
 *
 * Wraps everything in `<ConfirmProvider>` + `<ToastProvider>` so any
 * showcase can `useConfirm()` / `useToast()` without per-showcase
 * scaffolding.
 */
export function Shell() {
  const [activeId, setActiveId] = useState<string>(() =>
    typeof window === 'undefined' ? '' : window.location.hash.slice(1),
  );

  useEffect(() => {
    const handler = () => setActiveId(window.location.hash.slice(1));
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const entry = findEntry(activeId || null);

  return (
    <ConfirmProvider>
      <ToastProvider>
        <div className="flex min-h-dvh">
          <Sidebar activeId={entry.id} />
          <Main entry={entry} />
        </div>
      </ToastProvider>
    </ConfirmProvider>
  );
}

function Sidebar({ activeId }: { activeId: string }) {
  return (
    <aside className="w-64 shrink-0 bg-sidebar-bg border-r border-border-soft flex flex-col">
      <div className="p-5 border-b border-border-soft">
        <div className="text-soft-white font-semibold text-[14px]">@pyric/ui</div>
        <div className="text-muted-gray text-[11px] mt-0.5">component showcase</div>
      </div>
      <nav className="flex-1 overflow-y-auto py-3">
        {SECTIONS.map((section) => (
          <div key={section.id} className="mb-4">
            <div className="px-5 text-[10px] uppercase tracking-wider text-muted-gray font-semibold mb-1.5">
              {section.title}
            </div>
            <ul className="list-none m-0 p-0">
              {section.entries.map((entry) => (
                <li key={entry.id}>
                  <a
                    href={`#${entry.id}`}
                    className={[
                      'block px-5 py-1.5 text-[13px] font-display transition-colors',
                      entry.id === activeId
                        ? 'bg-primary-soft text-primary border-l-2 border-primary'
                        : 'text-soft-gray hover:bg-canvas-bg/40 border-l-2 border-transparent',
                    ].join(' ')}
                  >
                    {entry.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="p-4 border-t border-border-soft text-[11px] text-muted-gray">
        Styled via <code className="font-mono text-soft-gray">data-pyric-*</code>{' '}
        attribute selectors. The library ships no CSS.
      </div>
    </aside>
  );
}

function Main({ entry }: { entry: ShowcaseEntry }) {
  const { Component } = entry;
  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-10">
        <header className="mb-6">
          <h1 className="text-[26px] font-semibold text-soft-white">{entry.title}</h1>
          <p className="text-muted-gray text-[14px] mt-1">{entry.blurb}</p>
        </header>
        <section>
          <Component />
        </section>
      </div>
    </main>
  );
}
