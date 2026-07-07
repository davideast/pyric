/**
 * Clickable zero-state for the left-panel editors. Mirrors the
 * right-panel `EmptyState` (icon + title + body) but wraps everything
 * in a button so the entire panel area is the affordance for "click
 * to start writing." Once the user clicks, the editor mounts with
 * autoFocus so they can type immediately.
 */
interface EditorZeroStateProps {
  icon: string;
  title: string;
  body: string;
  onStart: () => void;
}

export function EditorZeroState({ icon, title, body, onStart }: EditorZeroStateProps) {
  return (
    <button
      type="button"
      onClick={onStart}
      // `h-full` (not `flex-1`) because the parent the editor mounts
      // into (`<div className="flex-1 min-h-0 overflow-hidden">` in
      // WorkspacePanel) isn't itself a flex container — `flex-1`
      // would be a no-op and the content would collapse to its
      // natural height at the top of the panel. `h-full` guarantees
      // we fill the slot regardless of the parent's display mode.
      className="h-full w-full flex flex-col items-center justify-center text-center px-8 gap-3 bg-content-bg hover:bg-[#1a1a22] transition-colors group"
    >
      <span className="material-symbols-outlined text-[40px] text-slate-gray opacity-50">
        {icon}
      </span>
      <p className="text-[16px] font-medium text-soft-white">{title}</p>
      <p className="text-[13px] text-slate-gray max-w-[320px]">{body}</p>
      <p className="text-[10px] font-mono uppercase tracking-wider text-slate-gray/60 group-hover:text-slate-gray mt-1">
        click to start writing
      </p>
    </button>
  );
}
