import { useLayoutEffect, useRef, type KeyboardEventHandler, type RefObject } from 'react';
import type { ContextSignalMatch } from '~/lib/agent/context';

interface PromptHighlightTextareaProps {
  value: string;
  onValueChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  matches: readonly ContextSignalMatch[];
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  spellCheck?: boolean;
  ariaLabel: string;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  className?: string;
  textClassName?: string;
  textareaClassName?: string;
}

export function PromptHighlightTextarea({
  value,
  onValueChange,
  textareaRef,
  matches,
  placeholder,
  rows,
  disabled = false,
  spellCheck = true,
  ariaLabel,
  onKeyDown,
  className = '',
  textClassName = '',
  textareaClassName = '',
}: PromptHighlightTextareaProps) {
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const renderedValue = value.length > 0 ? value : '';

  const syncScroll = () => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
  };

  useLayoutEffect(syncScroll, [value, textareaRef]);

  return (
    <div className={['relative overflow-hidden', className].filter(Boolean).join(' ')}>
      <div
        ref={mirrorRef}
        aria-hidden
        className={[
          'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-soft-white',
          textClassName,
        ].join(' ')}
      >
        {renderHighlightedText(renderedValue, matches)}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={syncScroll}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        spellCheck={spellCheck}
        aria-label={ariaLabel}
        className={[
          'relative z-10 w-full bg-transparent caret-soft-white placeholder:text-slate-gray/60 focus:outline-none selection:bg-[#3a3a48] selection:text-soft-white',
          value.length > 0 ? 'text-transparent' : 'text-soft-white',
          textClassName,
          textareaClassName,
        ].join(' ')}
      />
    </div>
  );
}

function renderHighlightedText(value: string, matches: readonly ContextSignalMatch[]) {
  if (!value) return null;

  const parts: JSX.Element[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      parts.push(<span key={`text-${cursor}`}>{value.slice(cursor, match.start)}</span>);
    }
    parts.push(
      <span
        key={`${match.lensId}-${match.start}-${match.end}`}
        className="prompt-signal-gradient-text"
      >
        {value.slice(match.start, match.end)}
      </span>,
    );
    cursor = match.end;
  }
  if (cursor < value.length) {
    parts.push(<span key={`text-${cursor}`}>{value.slice(cursor)}</span>);
  }
  return parts;
}
