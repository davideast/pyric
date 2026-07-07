export interface EmptyStateProps {
  icon?: string;
  title: string;
  body?: string;
}

export function EmptyState({ icon, title, body }: EmptyStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-8 gap-3">
      {icon ? (
        <span className="material-symbols-outlined text-[40px] text-slate-gray opacity-50">
          {icon}
        </span>
      ) : null}
      <p className="text-[16px] font-medium text-soft-white">{title}</p>
      {body ? <p className="text-[13px] text-slate-gray max-w-[320px]">{body}</p> : null}
    </div>
  );
}
