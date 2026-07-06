/**
 * One row in the agent's action timeline.
 *
 * Stacked layout: top strip carries the time + event-type chip (small,
 * inline); the row body takes the full width of the panel so long
 * messages have room to breathe. Click anywhere on the row to drill in.
 */

export interface TimelineEntryProps {
  time: string;
  eventType: string;
  active?: boolean;
  streaming?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}

export function TimelineEntry({
  time,
  eventType,
  active = false,
  streaming = false,
  children,
  onClick,
}: TimelineEntryProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full text-left rounded-md border transition-colors px-3 py-2 min-w-0',
        active
          ? 'bg-[#2a2a35]/40 border-[#2a2a35]'
          : 'bg-transparent border-transparent hover:bg-[#2a2a35]/20 hover:border-[#2a2a35]',
      ].join(' ')}
      style={active ? { borderLeft: '2px solid white' } : undefined}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className={`text-[11px] font-mono ${active || streaming ? 'text-soft-white' : 'text-slate-gray'}`}
        >
          {time}
        </span>
        <span className="text-slate-gray text-[10px]">·</span>
        {streaming ? (
          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-gray">
            live
          </span>
        ) : (
          <span className="text-[9px] font-bold uppercase tracking-wider text-slate-gray">
            {eventType}
          </span>
        )}
      </div>
      {children}
    </button>
  );
}
