import React, { useState } from 'react';

interface ErrorBannerProps {
  errorTitle: string;
  errorDetails: any;
  onClose: () => void;
  onOpenConsole: () => void;
}

function universalCopyText(text: string, onSuccess?: () => void): void {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(onSuccess).catch(() => executeFallbackCopy(text, onSuccess));
      return;
    }
  } catch {
    // Fallback copy inside iframe
  }
  executeFallbackCopy(text, onSuccess);
}

function executeFallbackCopy(text: string, onSuccess?: () => void): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    if (onSuccess) onSuccess();
  } catch (err) {
    console.warn('Fallback copy failed:', err);
  } finally {
    document.body.removeChild(textarea);
  }
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({
  errorTitle,
  errorDetails,
  onClose,
  onOpenConsole,
}) => {
  const [copied, setCopied] = useState(false);

  if (!errorDetails) return null;

  const titleText = String(errorTitle || 'Operation Denied');
  const isRuleDenial =
    errorDetails &&
    errorDetails.code === 'permission-denied' &&
    errorDetails.denialContext;

  const d = isRuleDenial ? errorDetails.denialContext : null;
  const ruleExpr = d && d.rule && d.rule.expression ? d.rule.expression : 'N/A';
  const ruleLine = d && d.rule && d.rule.line ? `Line ${d.rule.line}` : 'Unknown Line';
  const reasons =
    d && Array.isArray(d.reasons)
      ? d.reasons.join('\n')
      : String(errorDetails.message || errorDetails || '');

  const handleCopy = () => {
    const textToCopy = isRuleDenial
      ? `DENIED: ${d.method || 'WRITE'} ${d.path || 'doc'}\nRule (${ruleLine}): ${ruleExpr}\nReasoning:\n${reasons}`
      : `ERROR: ${titleText}\n${reasons}`;
    universalCopyText(textToCopy, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-zinc-900 border-2 border-red-500/50 p-4 shadow-2xl w-full">
      <div className="flex items-center justify-between gap-3 border-b border-red-500/20 pb-2">
        <span className="font-bold text-red-400 text-sm flex items-center gap-2">
          <span>🛡️</span>
          <span>Reactive Security Rules Denial Inspector</span>
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 font-bold text-[11px] transition-colors"
          >
            {copied ? '✓ Copied' : 'Copy Debug Log'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-white font-bold text-lg leading-none px-1"
          >
            &times;
          </button>
        </div>
      </div>

      {isRuleDenial ? (
        <div className="flex flex-col gap-2 w-full text-xs">
          <div className="flex items-center justify-between flex-wrap gap-1">
            <span className="font-semibold text-red-500 text-sm">🔒 {titleText}</span>
            <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-red-500/15 text-red-400 font-semibold">
              {d.method || 'WRITE'} {d.path || 'doc'}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold text-red-300">Failed Rule ({ruleLine}):</span>
            <div className="font-mono text-[11px] p-2 rounded bg-zinc-900 border border-red-500/30 text-red-400 font-medium overflow-x-auto">
              {ruleExpr}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold text-red-300">Rules Evaluator Reasoning:</span>
            <pre className="font-mono text-[11px] p-2 rounded bg-zinc-900 border border-red-500/30 text-zinc-300 overflow-x-auto whitespace-pre-wrap">
              {reasons}
            </pre>
          </div>
          <div className="flex justify-between items-center pt-2 border-t border-red-500/20 text-[11px] text-zinc-400">
            <span>Tip: Authoritative Rules Debug Context guides AI agents in diagnosing access denials.</span>
            <button
              type="button"
              onClick={onOpenConsole}
              className="underline font-semibold hover:text-white text-red-400"
            >
              Inspect Sandbox Rules &rarr;
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 w-full text-xs">
          <span className="font-semibold text-red-500 text-sm">⚠️ {titleText}</span>
          <pre className="font-mono text-[11px] p-2 rounded bg-zinc-900 border border-red-500/30 text-zinc-300 overflow-x-auto whitespace-pre-wrap">
            {reasons}
          </pre>
        </div>
      )}
    </section>
  );
};
