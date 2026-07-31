import React, { useState } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';

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
  const { sandboxDriver } = useWorkspace();
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
    <section id="error-banner" className="flex flex-col gap-3 rounded-xl bg-zinc-900 border-2 border-red-500/50 p-4 shadow-2xl w-full select-text cursor-default">
      <div className="flex items-center justify-between gap-3 border-b border-red-500/20 pb-2">
        <span className="font-bold text-red-400 text-sm flex items-center gap-2">
          <span>🛡️</span>
          <span>Reactive Security Rules Denial Inspector</span>
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopy}
            title="Copy Debug Log"
            className="p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700/60 transition-colors flex items-center justify-center cursor-pointer"
          >
            {copied ? (
              <svg className="w-3.5 h-3.5 text-emerald-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
              </svg>
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Dismiss"
            className="p-1.5 rounded-lg bg-transparent hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors flex items-center justify-center cursor-pointer font-bold text-base leading-none"
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
