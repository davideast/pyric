export interface ReadingPaneSectionProps {
  title?: string;
  children: React.ReactNode;
}

export function ReadingPaneSection({ title, children }: ReadingPaneSectionProps) {
  return (
    <section className="flex flex-col gap-2 mb-5">
      {title ? (
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-gray">
          {title}
        </h3>
      ) : null}
      <div className="text-[13px] leading-relaxed text-soft-white">{children}</div>
    </section>
  );
}
