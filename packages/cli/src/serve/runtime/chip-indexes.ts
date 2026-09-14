import { indexPresentation } from './service-presentation.js';
import type { ServiceIndexQuery, ServiceIndexFinding } from 'pyric/sandbox/internal';
import type { createIndexInspector } from './index-config-client.js';

type Inspector = ReturnType<typeof createIndexInspector>;
export function indexLabel(finding: ServiceIndexFinding): string {
  if (finding.status === 'missing') return 'Missing from config';
  if (finding.status === 'covered') return finding.basis === 'automatic' ? 'Automatic' : 'Configured';
  return 'Check unavailable';
}
export const INDEX_STYLES = `
  .btn.index-copy { width: 28px; min-width: 28px; height: 28px; border-color: transparent; background: transparent; }
  .btn.index-copy svg { width: 14px; height: 14px; }
  .btn.index-copy:hover, .btn.index-copy:focus-visible { background: var(--pyric-content); border-color: var(--pyric-border); }
  .btn.index-add { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 0; width: 120px; min-width: 120px; flex-basis: 120px; height: 32px; }
  .index-add-label { text-align: center; justify-self: stretch; }
  .index-add-status { display: grid; place-items: center; height: 100%; border-right: 1px solid var(--pyric-border); }
  .index-add-status svg { width: 14px; height: 14px; }
  .index-add[data-save-state="saving"] .index-add-status svg { animation: index-spin 1s linear infinite; }
  .index-add[data-save-state="saved"] .index-add-status { color: var(--pyric-accent); }
  .index-add[data-save-state="failed"] .index-add-status { color: var(--pyric-warning); }
  @keyframes index-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .index-add[data-save-state="saving"] .index-add-status svg { animation: none; } }
  .index-toolbar { display: grid; gap: 8px; width: 100%; min-width: 0; }
  .index-submit { justify-self: end; }
  .index-section { display: grid; gap: 12px; min-width: 0; }
  .index-fields { display: grid; gap: 8px; min-width: 0; }
  .index-definition-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; }
  .index-code { all: unset; display: block; font-family: var(--pyric-font-mono, 'Geist Mono', monospace); font-size: 11px; white-space: pre; overflow: auto; max-height: 180px; min-width: 0; }
  .index-code::after { content: ''; display: block; height: 16px; }
  .index-status { color: var(--pyric-warning); }
  .verdict.index-warning { --verdict-border: #72644c; background: #2f2c26; color: #d6ccb8; }
  .verdict.index-warning .verdict-icon { color: #d6c096; }
  .verdict.index-warning svg { width: 12px; height: 12px; flex-shrink: 0; }
  .index-error { color: var(--pyric-error); }
  .index-preview-fields { display: grid; gap: 8px; }
  .index-preview-field { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 12px; }
  .index-preview-field code { overflow-wrap: anywhere; }

`;

/** Index information inherits Traffic's record and field tracks. Every sentence explains an action or a limit. */
export function indexDetailsHtml(query: ServiceIndexQuery, key: string, inspector: Inspector, escape: (text: string) => string, chevron: string, copyIcon: string): string {
  const state = inspector.state(query);
  const finding = inspector.finding(query);
  const attr = `data-index-key="${escape(key)}"`;
  const fact = (label: string, value: string) => `<div class="request-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
  const field = (value: string) => `<code class="mono">${escape(value)}</code>`;
  const preview = state.preview?.key === key ? state.preview.value : null;
  const addition = preview?.addition ?? (finding.status === 'covered' ? undefined : finding.index);
  const presentation = indexPresentation(query, addition);
  const facts = fact('Index', (finding.status === 'missing' ? `<span class="index-status">${indexLabel(finding)}</span>` : indexLabel(finding)))
    + presentation.facts.map(item => fact(item.label, `<span class="index-fields">${item.values.map(value => `<span>${value.code ? field(value.code) : ''}${value.text ? ` ${escape(value.text)}` : ''}</span>`).join('')}</span>`)).join('')
    + (state.config ? fact('File', field(state.config.path)) : '')
    + (finding.status === 'unavailable' ? fact('Reason', escape(state.error ?? finding.reason)) : '')
    + (finding.status === 'missing' && finding.editBlocked ? fact('Action', escape(finding.editBlocked)) : '');
  const code = addition ? `<div class="rules-record"><div class="rules-record-body"><div class="index-definition-header"><strong>Index definition</strong><button type="button" class="btn icon-button index-copy" data-index-action="copy" ${attr} aria-label="Copy index definition" title="${state.copied ? 'Copied' : 'Copy index definition'}">${state.copied ? statusIcon('saved') : copyIcon}</button></div><div class="index-preview-fields">${presentation.fields.map(item => `<div class="index-preview-field">${field(item.code)}${item.text ? `<span>${escape(item.text)}</span>` : ''}</div>`).join('')}</div><details class="rules-disclosure" data-index-json="${escape(key)}"><summary><span>JSON definition</span><span class="rules-chevron">${chevron}</span></summary><pre class="index-code" tabindex="0" aria-label="Index addition">${escape(JSON.stringify(presentation.definition, null, 2))}</pre></details></div></div>` : '';
  return `<section class="index-section" data-index-details><div class="rows"><div class="rules-record"><div class="rules-record-body"><dl class="rules-facts">${facts}</dl></div></div>${code}</div>${state.error && finding.status !== 'unavailable' ? `<span class="index-error" role="alert">${escape(state.error)}</span>` : ''}${state.message ? `<span role="status">${escape(state.message)}</span>` : ''}</section>`;
}


export function indexActionHtml(query: ServiceIndexQuery | undefined, key: string, inspector: Inspector, escape: (text: string) => string): string {
  if (!query) return '';
  const state = inspector.state(query);
  if (state.preview?.key !== key || !state.preview.value.addition) return '';
  const added = inspector.finding(query).status === 'covered';
  const status = added ? 'saved' : state.pending === 'apply' ? 'saving' : state.saveFailed ? 'failed' : 'ready';
  const destination = state.config?.path ?? 'local configuration';
  const title = added ? `Saved to ${destination}` : status === 'failed' ? `Retry adding index to ${destination}` : `Add index to ${destination}`;
  return `<button type="button" class="btn index-add" data-save-state="${status}" aria-label="Add index" title="${escape(title)}" data-index-action="apply" data-index-key="${escape(key)}"${state.busy || added ? ' disabled' : ''}><span class="index-add-status" aria-hidden="true">${statusIcon(status)}</span><span class="index-add-label">Add index</span><span class="sr-only" role="status">${status}</span></button>`;
}


function statusIcon(status: 'ready' | 'saving' | 'saved' | 'failed'): string {
  const paths = {
    ready: '<path d="M12 5v14M5 12h14"/>',
    saving: '<path d="M20 12a8 8 0 1 1-8-8"/>',
    saved: '<path d="m5 12 4 4L19 6"/>',
    failed: '<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5m0 3v1"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${paths[status]}</svg>`;
}
