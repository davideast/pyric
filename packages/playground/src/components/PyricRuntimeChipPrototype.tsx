/**
 * PROTOTYPE — three runtime-chip layouts on the existing playground home route.
 * Open `/?prototype=runtime-chip&variant=A` and switch with the floating rail.
 */
import { useEffect, useState } from 'react';

const ERRORS = [
  'Firestore listener failed: Missing or insufficient permissions.',
  'Functions RTDB child failed: pyric-admin/messaging could not be resolved.',
  'AI proxy upstream returned 502 for model ornith:9b.',
];

const variants = [
  { key: 'A', name: 'Anchored chip' },
  { key: 'B', name: 'Bottom console' },
  { key: 'C', name: 'Sidecar tab' },
] as const;

function StatusDot() {
  return <span className="h-2 w-2 rounded-full bg-[#f0a0a0] shadow-[0_0_0_3px_rgba(240,160,160,0.12)]" />;
}

function CopyIcon() {
  return (
    <button type="button" title="Copy errors" aria-label="Copy errors" className="rounded p-1 text-slate-gray hover:bg-white/5 hover:text-soft-white">
      <span className="material-symbols-outlined text-[15px]">content_copy</span>
    </button>
  );
}

function ErrorViewport() {
  return (
    <div className="custom-scrollbar max-h-44 overflow-y-auto border-y border-[#2a2a35] bg-[#16161a]">
      {ERRORS.map((error, index) => (
        <div key={error} className="flex gap-2 border-b border-[#2a2a35]/70 px-3 py-2.5 last:border-b-0">
          <span className="font-mono text-[10px] text-[#f0a0a0]">{String(index + 1).padStart(2, '0')}</span>
          <code className="min-w-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[#d7d7df]">{error}</code>
          <CopyIcon />
        </div>
      ))}
    </div>
  );
}

function Actions() {
  return (
    <div className="grid grid-cols-2 gap-2 p-3">
      <button type="button" className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded border border-[#e6c79c]/40 bg-[#e6c79c]/10 px-2 font-mono text-[10px] uppercase tracking-wider text-[#e6c79c] hover:bg-[#e6c79c]/15">
        <span className="material-symbols-outlined text-[14px]">refresh</span>
        Update worker
      </button>
      <button type="button" className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded border border-[#2a2a35] px-2 font-mono text-[10px] uppercase tracking-wider text-slate-gray hover:border-[#3a3a48] hover:text-soft-white">
        Studio
        <span className="material-symbols-outlined text-[14px]">open_in_new</span>
      </button>
    </div>
  );
}

function Header({ onClose }: { onClose(): void }) {
  return (
    <div className="flex h-11 items-center justify-between px-3">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-[17px] text-soft-white/80">terminal</span>
        <span className="font-mono text-[12px] text-soft-white">Pyric runtime</span>
        <span className="rounded-full border border-[#3a2a2a] bg-[#3a2a2a]/30 px-1.5 py-0.5 font-mono text-[9px] text-[#f0a0a0]">3 errors</span>
      </div>
      <button type="button" onClick={onClose} aria-label="Collapse runtime panel" className="rounded p-1 text-slate-gray hover:bg-white/5 hover:text-soft-white">
        <span className="material-symbols-outlined text-[17px]">close</span>
      </button>
    </div>
  );
}

function CompactButton({ onOpen, shape = 'pill' }: { onOpen(): void; shape?: 'pill' | 'bar' }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={[
        'flex items-center border border-[#33333f] bg-sidebar-bg text-soft-white shadow-2xl transition-colors hover:border-[#4a4a58]',
        shape === 'pill' ? 'h-9 gap-2 rounded-full px-3' : 'h-9 w-full justify-between rounded-t px-3',
      ].join(' ')}
    >
      <span className="flex items-center gap-2"><StatusDot /><span className="font-mono text-[11px]">Pyric</span></span>
      <span className="flex items-center gap-2 font-mono text-[10px] text-slate-gray"><span className="text-[#e6c79c]">update</span><span>3 errors</span><span className="material-symbols-outlined text-[14px]">expand_less</span></span>
    </button>
  );
}

function VariantA() {
  const [open, setOpen] = useState(true);
  return (
    <div className="fixed bottom-5 right-5 z-[3000] w-[min(380px,calc(100vw-2.5rem))]">
      {open ? (
        <section className="overflow-hidden rounded-lg border border-[#33333f] bg-sidebar-bg shadow-[0_18px_60px_rgba(0,0,0,0.45)]">
          <Header onClose={() => setOpen(false)} />
          <div className="flex items-center justify-between border-t border-[#2a2a35] px-3 py-2 font-mono text-[10px] text-slate-gray">
            <span className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[#e6c79c]" />New worker available</span>
            <span>fedcba98 → 01234567</span>
          </div>
          <ErrorViewport />
          <Actions />
        </section>
      ) : <div className="flex justify-end"><CompactButton onOpen={() => setOpen(true)} /></div>}
    </div>
  );
}

function VariantB() {
  const [open, setOpen] = useState(true);
  return (
    <div className="fixed inset-x-0 bottom-0 z-[3000] mx-auto w-[min(720px,calc(100vw-2rem))]">
      {open ? (
        <section className="overflow-hidden rounded-t-lg border-x border-t border-[#33333f] bg-sidebar-bg shadow-[0_-18px_50px_rgba(0,0,0,0.35)]">
          <Header onClose={() => setOpen(false)} />
          <div className="grid md:grid-cols-[1fr_220px]">
            <ErrorViewport />
            <div className="flex flex-col justify-between border-l border-[#2a2a35]">
              <div className="p-3 font-mono text-[10px] text-slate-gray"><span className="mb-2 block text-[#e6c79c]">Worker update ready</span>Reloads all tabs after accepted sandbox work drains.</div>
              <Actions />
            </div>
          </div>
        </section>
      ) : <CompactButton shape="bar" onOpen={() => setOpen(true)} />}
    </div>
  );
}

function VariantC() {
  const [open, setOpen] = useState(true);
  return (
    <div className="fixed bottom-5 right-0 top-[76px] z-[3000] flex items-end">
      {open ? (
        <section className="mb-0 flex max-h-[min(520px,calc(100vh-110px))] w-[min(360px,calc(100vw-2rem))] flex-col overflow-hidden rounded-l-lg border border-r-0 border-[#33333f] bg-sidebar-bg shadow-[-18px_0_50px_rgba(0,0,0,0.35)]">
          <Header onClose={() => setOpen(false)} />
          <div className="px-3 pb-3 font-mono text-[10px] text-[#e6c79c]">A newer sandbox worker is waiting.</div>
          <ErrorViewport />
          <Actions />
        </section>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="mb-3 flex flex-col items-center gap-2 rounded-l-lg border border-r-0 border-[#33333f] bg-sidebar-bg px-2 py-3 shadow-xl">
          <StatusDot /><span className="font-mono text-[10px] text-soft-white [writing-mode:vertical-rl]">Pyric runtime</span><span className="font-mono text-[9px] text-[#f0a0a0]">3</span>
        </button>
      )}
    </div>
  );
}

function PrototypeSwitcher({ current }: { current: string }) {
  const select = (key: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('variant', key);
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable]')) return;
      const index = Math.max(0, variants.findIndex((item) => item.key === current));
      const offset = event.key === 'ArrowLeft' ? -1 : 1;
      select(variants[(index + offset + variants.length) % variants.length]!.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current]);
  const index = Math.max(0, variants.findIndex((item) => item.key === current));
  return (
    <div className="fixed bottom-4 left-1/2 z-[4000] flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/20 bg-black px-2 py-1.5 text-white shadow-2xl">
      <button type="button" className="rounded-full px-2 py-1 hover:bg-white/10" onClick={() => select(variants[(index - 1 + variants.length) % variants.length]!.key)}>←</button>
      <span className="min-w-36 text-center font-mono text-[11px]">{variants[index]!.key} — {variants[index]!.name}</span>
      <button type="button" className="rounded-full px-2 py-1 hover:bg-white/10" onClick={() => select(variants[(index + 1) % variants.length]!.key)}>→</button>
    </div>
  );
}

export function PyricRuntimeChipPrototype() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const onPopState = () => rerender((value) => value + 1);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  if (!import.meta.env.DEV || new URLSearchParams(window.location.search).get('prototype') !== 'runtime-chip') return null;
  const variant = new URLSearchParams(window.location.search).get('variant') ?? 'A';
  return (
    <>
      {variant === 'B' ? <VariantB /> : variant === 'C' ? <VariantC /> : <VariantA />}
      <PrototypeSwitcher current={variant} />
    </>
  );
}
