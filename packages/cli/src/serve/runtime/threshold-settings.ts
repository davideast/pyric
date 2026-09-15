import { readThresholdConfig, thresholdDefaults, thresholdLimit, THRESHOLD_OPERATIONS, type ThresholdConfig, type ThresholdService, type ThresholdOperation } from './rate-threshold-config.js';
import type { ThresholdConfigClient, LocalThresholdConfig } from './threshold-config-client.js';

/** Owns draft edits independently of live rate refreshes. Only Save changes effective limits. */
export function createThresholdSettings(client: ThresholdConfigClient | undefined, changed: () => void) {
  let config: ThresholdConfig = {};
  let local: LocalThresholdConfig | null = null;
  let draft: ThresholdConfig | null = null;
  let service: ThresholdService | null = null;
  let busy = false;
  let loaded = false;
  let saving = false;
  let disposed = false;
  let error: string | null = null;
  let invalid = false;
  let request = 0;
  async function load() {
    const version = ++request;
    busy = true; error = null; changed();
    try {
      const next = client ? await client.read() : null;
      if (disposed || version !== request) return;
      local = next;
      if (next) config = next.config;
      if (service) draft = structuredClone(config);
      loaded = true;
    } catch (cause) { if (version === request) error = cause instanceof Error ? cause.message : 'Unable to load thresholds.'; }
    finally { if (version === request) { busy = false; if (!disposed) changed(); } }
  }
  return {
    config: () => config,
    ready: () => loaded,
    state: () => ({ config, draft, service, busy, saving, error, loaded, project: local !== null, dirty: draft !== null && JSON.stringify(draft) !== JSON.stringify(config), invalid }),
    load,
    open(next: ThresholdService) { service = next; draft = structuredClone(config); invalid = false; void load(); },
    cancel() { service = null; draft = null; error = null; invalid = false; changed(); },
    defaults() { if (service && draft) { draft = thresholdDefaults(draft, service); invalid = false; error = null; changed(); } },
    edit(key: ThresholdOperation | 'sustainedSeconds', value: string) {
      if (!draft || !service) return;
      const number = value.trim() === '' ? null : Number(value);
      if (key === 'sustainedSeconds') draft = { ...draft, sustainedSeconds: number ?? NaN };
      else draft = { ...draft, [service]: { ...draft[service], [key]: number } };
      try { readThresholdConfig(draft); error = null; invalid = false; }
      catch (cause) { error = cause instanceof Error ? cause.message : 'Enter a valid limit.'; invalid = true; }
    },
    async save() {
      if (!draft || busy || invalid || !loaded) return;
      busy = true; saving = true; error = null; changed();
      try {
        const next = readThresholdConfig(draft);
        if (local && client) { local = await client.save(next, local.revision); config = local.config; }
        else config = next;
        service = null; draft = null;
      } catch (cause) { error = cause instanceof Error ? cause.message : 'Unable to save thresholds.'; }
      finally { busy = false; saving = false; if (!disposed) changed(); }
    },
    dispose() { disposed = true; request++; },
  };
}
export type ThresholdSettings = ReturnType<typeof createThresholdSettings>;
const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 4, ...(value >= 1_000_000 ? { notation: 'compact' as const } : {}) });
export function thresholdSettingsHtml(settings: ThresholdSettings, escape: (value: string) => string): string {
  const state = settings.state();
  if (!state.service || !state.draft) return '';
  const draft = state.draft;
  const rows = THRESHOLD_OPERATIONS[state.service].map(operation => {
    const limit = thresholdLimit(draft, state.service!, operation.key);
    const configured = Object.hasOwn(draft[state.service!] ?? {}, operation.key);
    return `<div class="threshold-row"><label for="threshold-${operation.key}">${operation.label}<span class="threshold-origin">${configured ? state.project ? 'Project' : 'This session' : 'Default'}</span></label><input id="threshold-${operation.key}" data-threshold-input="${operation.key}" aria-label="${operation.label} per second" aria-describedby="threshold-help" type="number" min="0" max="1000000" step="any" placeholder="Off" value="${limit === null || !Number.isFinite(limit) ? '' : limit}" ${state.busy ? 'disabled' : ''}><span class="threshold-equivalent" data-threshold-equivalent="${operation.key}">${limit === null ? 'Off' : `${number(limit * 60)}/min`}</span></div>`;
  }).join('');
  return `<div class="threshold-settings"><p class="threshold-context">Measures activity on this page.</p><div class="rows threshold-table"><div class="threshold-row threshold-head"><span>Operation</span><span>Warn above/s</span><span>If sustained</span></div>${rows}</div><p class="threshold-context" id="threshold-help">Leave a limit empty to turn its warning off.</p><div class="rows"><div class="threshold-row threshold-duration"><label for="threshold-duration">Sustained for<span class="threshold-origin">Applies to all services</span></label><input id="threshold-duration" data-threshold-input="sustainedSeconds" aria-label="Sustained seconds" type="number" min="1" max="60" step="1" value="${Number.isFinite(draft.sustainedSeconds ?? 5) ? draft.sustainedSeconds ?? 5 : ''}" ${state.busy ? 'disabled' : ''}><span>seconds</span></div></div><p class="threshold-context">${state.project ? 'Saved in pyric.json.' : 'This session only. Settings reset when this page reloads.'}</p><p class="threshold-error" data-threshold-error role="alert" ${state.error ? '' : 'hidden'}>${escape(state.error ?? '')}</p></div>`;
}
export function refreshThresholdForm(root: ParentNode, settings: ThresholdSettings): void {
  const state = settings.state();
  const save = root.querySelector<HTMLButtonElement>('[data-threshold-save]');
  if (save) save.disabled = state.busy || !state.loaded || !state.dirty || state.invalid;
  const error = root.querySelector<HTMLElement>('[data-threshold-error]');
  if (error) { error.hidden = !state.error; error.textContent = state.error ?? ''; }
  for (const element of root.querySelectorAll<HTMLElement>('[data-threshold-equivalent]')) {
    if (!state.service || !state.draft) continue;
    const limit = thresholdLimit(state.draft, state.service, element.dataset.thresholdEquivalent as ThresholdOperation);
    element.textContent = limit === null ? 'Off' : Number.isFinite(limit) ? `${number(limit * 60)}/min` : '';
  }
}
export const THRESHOLD_STYLES = `
.threshold-settings { display:grid; gap:var(--space-3); }
.threshold-context,.threshold-error { margin:0 var(--record-inset); font-size:11px; line-height:1.5; }
.threshold-context,.threshold-origin,.threshold-head,.threshold-equivalent { color:var(--pyric-muted); }
.threshold-error { color:var(--pyric-error); }
.threshold-row { display:grid; grid-template-columns:minmax(0,1fr) 84px 88px; align-items:center; gap:var(--space-2); padding:var(--space-3); min-height:60px; font-size:12px; }
.threshold-row + .threshold-row { border-top:1px solid var(--pyric-border-soft); }
.threshold-head { min-height:40px; font-size:11px; }
.threshold-head > :not(:first-child),.threshold-equivalent { text-align:right; font-variant-numeric:tabular-nums; }
.threshold-origin { display:block; font-size:10px; margin-top:var(--space-1); }
.threshold-row input { appearance:textfield; box-sizing:border-box; min-width:0; width:100%; height:36px; padding:0 var(--space-2); text-align:right; font:inherit; font-variant-numeric:tabular-nums; color:var(--pyric-text); background:var(--pyric-content); border:1px solid var(--pyric-border); border-radius:4px; }
.threshold-settings input::-webkit-inner-spin-button,.threshold-settings input::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
.threshold-row input:focus-visible { outline:2px solid var(--pyric-accent); outline-offset:2px; }
.threshold-duration > :last-child { text-align:right; }
.threshold-footer { display:flex; align-items:center; justify-content:space-between; gap:var(--space-2); width:100%; }
.threshold-footer > span { display:flex; gap:var(--space-2); }
.threshold-footer [data-threshold-save] { min-width:64px; }
.rate-alert { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--space-2); padding:var(--space-3); width:100%; text-align:left; background:none; color:inherit; border:0; font:inherit; cursor:pointer; }
.rate-alert + .rate-alert { border-top:1px solid var(--pyric-border-soft); }
.rate-alert:hover { background:var(--pyric-bg); }
.rate-alert:focus-visible { outline:2px solid var(--pyric-accent); outline-offset:-2px; }
.rate-alert small { display:block; color:var(--pyric-muted); font-size:11px; margin-top:var(--space-1); }
.rate-alert-status { display:flex; align-items:center; border:1px solid #695b45; border-radius:4px; color:var(--pyric-warning); font-size:11px; align-self:start; }
.rate-alert-status svg { width:14px; height:14px; margin:6px; }
.rate-alert-status span { border-left:1px solid #695b45; padding:6px; min-width:62px; text-align:right; }
`;
