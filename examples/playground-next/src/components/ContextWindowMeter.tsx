import {
  ContextWindowMeter as HeadlessContextWindowMeter,
  ContextWindowRing as HeadlessContextWindowRing,
} from '@pyric/ui/agents';
import type { ContextWindowSnapshot } from '~/lib/agent/context-window';

interface ContextWindowRingProps {
  snapshot: ContextWindowSnapshot;
  size?: number;
}

interface ContextWindowMeterProps {
  snapshot: ContextWindowSnapshot;
  onOpen?: () => void;
}

export function ContextWindowRing({ snapshot, size = 20 }: ContextWindowRingProps) {
  return (
    <HeadlessContextWindowRing
      snapshot={snapshot}
      size={size}
      className="inline-grid place-items-center rounded-full shrink-0"
      innerClassName="rounded-full bg-sidebar-bg"
    />
  );
}

export function ContextWindowMeter({ snapshot, onOpen }: ContextWindowMeterProps) {
  return (
    <span data-context-window-meter>
      <HeadlessContextWindowMeter
        snapshot={snapshot}
        onOpen={onOpen}
        className="relative group shrink-0"
        buttonClassName="h-8 w-8 inline-grid place-items-center rounded-full text-slate-gray hover:text-soft-white hover:bg-soft-white/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-soft-white/40 transition-colors"
        ringClassName="inline-grid place-items-center rounded-full shrink-0"
        ringInnerClassName="rounded-full bg-sidebar-bg"
        tooltipClassName="pointer-events-none absolute bottom-full right-1/2 translate-x-1/2 mb-2 hidden min-w-[190px] rounded-2xl border border-[#3a3a45] bg-[#2a2a2f] px-4 py-3 text-center shadow-xl group-hover:grid group-focus-within:grid z-50 text-[12px] text-slate-gray font-display gap-1"
      />
    </span>
  );
}
