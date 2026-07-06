/**
 * Drill-in view for a single timeline action. Each major slot is
 * optional — caller decides what shows. Back button returns to the
 * parent timeline.
 */
import { ReadingPaneSection } from './ReadingPaneSection';

export interface ReadingPaneFile {
  path: string;
  additions?: number;
  deletions?: number;
}

export interface ReadingPaneProps {
  title?: string;
  eyebrow?: string;
  summary?: string;
  status?: string;
  files?: ReadingPaneFile[];
  source?: { language?: string; body: string };
  onBack?: () => void;
}

export function ReadingPane({
  title,
  eyebrow,
  summary,
  status,
  files,
  source,
  onBack,
}: ReadingPaneProps) {
  return (
    <div className="flex-1 px-4 pt-4 pb-6 overflow-y-auto custom-scrollbar">
      <div className="flex flex-col">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 text-slate-gray hover:text-soft-white transition-colors text-[12px] mb-3 w-fit"
          >
            <span className="material-symbols-outlined text-[16px]">arrow_back</span>
            <span>Back</span>
          </button>
        ) : null}

        {eyebrow ? (
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-gray mb-1.5">
            {eyebrow}
          </p>
        ) : null}
        {title ? (
          <h2 className="text-[18px] font-display font-medium text-soft-white mb-4">
            {title}
          </h2>
        ) : null}

        {summary ? (
          <ReadingPaneSection title="Summary">
            <p className="whitespace-pre-wrap break-words">{summary}</p>
          </ReadingPaneSection>
        ) : null}

        {status ? (
          <ReadingPaneSection title="What happened">
            <pre className="text-[12px] font-mono text-slate-gray whitespace-pre-wrap break-words">
              {status}
            </pre>
          </ReadingPaneSection>
        ) : null}

        {files && files.length > 0 ? (
          <ReadingPaneSection title="Files">
            <ul className="flex flex-col gap-1.5">
              {files.map((f) => (
                <li key={f.path} className="flex items-center gap-3 text-[12px] font-mono">
                  <span className="text-soft-white truncate flex-1">{f.path}</span>
                  {f.additions !== undefined ? (
                    <span className="text-green-500 shrink-0">+{f.additions}</span>
                  ) : null}
                  {f.deletions !== undefined ? (
                    <span className="text-red-500 shrink-0">-{f.deletions}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </ReadingPaneSection>
        ) : null}

        {source ? (
          <ReadingPaneSection title={source.language ? `Source · ${source.language}` : 'Source'}>
            <pre className="text-[12px] font-mono text-soft-white bg-content-bg border border-[#2a2a35] rounded-md p-3 overflow-x-auto">
              {source.body}
            </pre>
          </ReadingPaneSection>
        ) : null}
      </div>
    </div>
  );
}
