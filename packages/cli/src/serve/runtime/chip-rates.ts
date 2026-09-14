import type { SdkMethodRate, SdkRateSnapshot, SdkServiceRate } from 'pyric/sandbox/internal';

export interface RateView {
  readonly title: string;
  readonly detail: string;
  readonly body: string;
}

type Escape = (value: string) => string;

export const RATE_STYLES = `
  .rate-table { display:grid; width:100%; border-collapse:collapse; font-size:12px; }
  .rate-table colgroup { display:none; }
  .rate-table thead,.rate-table tbody { display:contents; }
  .rate-table tr { display:grid; grid-template-columns:4px minmax(0,1fr) repeat(3,52px) 4px; column-gap:var(--space-2); }
  .rate-table th,.rate-table td { display:flex; min-width:0; min-height:44px; align-items:center; justify-content:flex-end; }
  .rate-table tr > :first-child { grid-column:2; justify-content:flex-start; }
  .rate-table tr > :nth-child(2) { grid-column:3; }
  .rate-table tr > :nth-child(3) { grid-column:4; }
  .rate-table tr > :nth-child(4) { grid-column:5; }
  .rate-table thead { color:var(--pyric-muted); font-size:11px; }
  .rate-table thead th { font-weight:500; }
  .rate-table th { text-align:left; font-weight:500; }
  .rate-table td,.rate-table thead th:not(:first-child) { text-align:right; }
  .rate-table tbody tr { border-top:1px solid var(--pyric-border); }
  .rate-table td { font-variant-numeric:tabular-nums; }
  .rate-table button { width:100%; min-height:44px; display:flex; align-items:center; text-align:left; color:var(--pyric-accent); background:none; border:0; padding:0; font:inherit; cursor:pointer; }
  .rate-table button:hover { text-decoration:underline; }
  .rate-table button:focus-visible { outline:2px solid var(--pyric-accent); outline-offset:-2px; border-radius:4px; }
  .rate-table code { display:block; max-width:100%; overflow-x:auto; white-space:nowrap; font-size:12px; line-height:28px; scrollbar-width:thin; }
  .rate-table tr > .rate-unavailable { grid-column:3 / 6; color:var(--pyric-muted); font-family:inherit; }
  .rate-scope { display:grid; gap:8px; }
  .rate-scope dl { display:grid; grid-template-columns:4px minmax(0,1fr) auto 4px; gap:var(--space-2); margin:0; font-size:12px; }
  .rate-scope dt { grid-column:2; color:var(--pyric-muted); }
  .rate-scope dd { grid-column:3; margin:0; text-align:right; }
  .traffic-toolbar { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; }
`;

function rateNumber(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function categoryRate(service: SdkServiceRate, category: SdkMethodRate['category']): number {
  return service.methods.filter(method => method.category === category)
    .reduce((total, method) => total + method.callsPerSecond, 0);
}

function listenerUpdates(service: SdkServiceRate): number {
  return service.methods.filter(method => method.category === 'listener')
    .reduce((total, method) => total + method.deliveriesPerSecond, 0);
}

function serviceRow(service: SdkServiceRate, label: string, escape: Escape): string {
  const name = escape(label);
  if (service.coverage === 'unsupported') {
    return `<tr data-rate-service="${escape(service.service)}"><th scope="row">${name}</th><td colspan="3" class="rate-unavailable">Not measured</td></tr>`;
  }
  return `<tr data-rate-service="${escape(service.service)}"><th scope="row"><button type="button" data-inspect-rates="${escape(service.service)}">${name}</button></th>`
    + `<td class="mono" data-rate-reads>${rateNumber(categoryRate(service, 'read'))}</td>`
    + `<td class="mono" data-rate-writes>${rateNumber(categoryRate(service, 'write'))}</td>`
    + `<td class="mono" data-rate-updates>${rateNumber(listenerUpdates(service))}</td></tr>`;
}

function methodRow(method: SdkMethodRate, escape: Escape): string {
  const name = escape(method.method);
  let listening = '<span aria-label="Not a listener">·</span>';
  if (method.category === 'listener') listening = String(method.activeListeners);
  let results = '<span aria-label="No data result">·</span>';
  if (method.category !== 'write') results = rateNumber(method.deliveriesPerSecond);
  return `<tr data-rate-method="${name}"><th scope="row"><code class="mono" tabindex="0" title="${name}">${name}</code></th>`
    + `<td class="mono" data-rate-calls>${rateNumber(method.callsPerSecond)}</td>`
    + `<td class="mono" data-rate-results>${results}</td><td class="mono" data-rate-active>${listening}</td></tr>`;
}

/** The same numeric tracks serve service summaries and public method detail. */
export function rateView(
  snapshot: SdkRateSnapshot,
  selectedService: string | null,
  serviceLabel: (service: string) => string,
  escape: Escape,
): RateView {
  const service = snapshot.services.find(entry => entry.service === selectedService);
  const detail = `${snapshot.windowSeconds}-second average`;
  if (!service || service.coverage === 'unsupported') {
    const rows = snapshot.services.map(entry => serviceRow(entry, serviceLabel(entry.service), escape));
    return {
      title: 'SDK activity', detail,
      body: `<div class="rows" data-service-rates><table class="rate-table" aria-label="SDK activity by service"><colgroup><col class="rate-name"><col><col><col></colgroup><thead><tr><th scope="col">Service</th><th scope="col">Reads/s</th><th scope="col">Writes/s</th><th scope="col">Updates/s</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`,
    };
  }
  const listeners = service.methods.reduce((total, method) => total + method.activeListeners, 0);
  const untracked = service.untrackedMethods.map(method => `<tr data-rate-method="${escape(method)}"><th scope="row"><code class="mono">${escape(method)}</code></th><td colspan="3" class="rate-unavailable">Not measured</td></tr>`).join('');
  return {
    title: serviceLabel(service.service), detail,
    body: `<div class="rate-scope" data-rate-detail="${escape(service.service)}"><dl><dt>Scope</dt><dd>This page</dd><dt>Measurement</dt><dd>Listed SDK methods</dd><dt>Active listeners</dt><dd data-rate-listeners>${listeners}</dd></dl>`
      + `<div class="rows"><table class="rate-table" aria-label="SDK activity by method"><colgroup><col class="rate-name"><col><col><col></colgroup><thead><tr><th scope="col">Method</th><th scope="col" title="Includes denied attempts">Calls/s</th><th scope="col" title="Read results and listener callbacks">Results/s</th><th scope="col">Listening</th></tr></thead><tbody>${service.methods.map(method => methodRow(method, escape)).join('')}${untracked}</tbody></table></div></div>`,
  };
}

function replaceNumber(root: ParentNode, selector: string, value: number): void {
  const element = root.querySelector(selector);
  const text = rateNumber(value);
  if (element && element.textContent !== text) element.textContent = text;
}

/** Refresh measurements without replacing focused controls or scrolled code. */
export function refreshRateView(root: ParentNode, snapshot: SdkRateSnapshot): void {
  for (const row of root.querySelectorAll<HTMLElement>('[data-rate-service]')) {
    const service = snapshot.services.find(entry => entry.service === row.dataset.rateService);
    if (!service || service.coverage === 'unsupported') continue;
    replaceNumber(row, '[data-rate-reads]', categoryRate(service, 'read'));
    replaceNumber(row, '[data-rate-writes]', categoryRate(service, 'write'));
    replaceNumber(row, '[data-rate-updates]', listenerUpdates(service));
  }
  const detail = root.querySelector<HTMLElement>('[data-rate-detail]');
  const service = snapshot.services.find(entry => entry.service === detail?.dataset.rateDetail);
  if (!detail || !service) return;
  replaceNumber(detail, '[data-rate-listeners]', service.methods.reduce((total, method) => total + method.activeListeners, 0));
  for (const row of detail.querySelectorAll<HTMLElement>('[data-rate-method]')) {
    const method = service.methods.find(entry => entry.method === row.dataset.rateMethod);
    if (!method) continue;
    replaceNumber(row, '[data-rate-calls]', method.callsPerSecond);
    if (method.category !== 'write') replaceNumber(row, '[data-rate-results]', method.deliveriesPerSecond);
    if (method.category === 'listener') replaceNumber(row, '[data-rate-active]', method.activeListeners);
  }
}
