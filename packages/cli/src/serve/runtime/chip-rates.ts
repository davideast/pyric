import { measurementNotes } from './rate-measurement-notes.js';
import { createRateHistory, historyHtml, refreshHistory, HISTORY_STYLES, type HistoryFrame } from './rate-history.js';
import type { SdkMethodRate, SdkRateSnapshot, SdkServiceRate } from 'pyric/sandbox/internal';

export interface RateView {
  readonly title: string;
  readonly detail: string;
  readonly body: string;
}

type Escape = (value: string) => string;

export const RATE_STYLES = HISTORY_STYLES + `
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
  .rate-service-item { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--space-3); align-items:center; padding:var(--space-3); font-size:12px; }
  .rate-service-item + .rate-service-item { border-top:1px solid var(--pyric-border-soft); }
  .rate-service-item button { border:0; background:none; color:var(--pyric-accent); text-align:left; font:inherit; padding:0; cursor:pointer; }
  .rate-service-item button:focus-visible { outline:2px solid var(--pyric-accent); outline-offset:4px; }
  .rate-service-item small { display:block; color:var(--pyric-muted); font-size:11px; line-height:1.5; margin-top:var(--space-1); }
  .rate-service-item .rate-incident-count { color:var(--pyric-warning); white-space:nowrap; font-size:11px; }
  .rate-no-incidents { color:var(--pyric-muted); font-size:11px; }
  .bar:has(.rate-menu) { overflow:visible; position:relative; z-index:2; }
  .rate-menu { position:relative; }
  .rate-menu summary { list-style:none; cursor:pointer; display:flex; align-items:center; justify-content:center; width:32px; height:32px; }
  .rate-menu summary::-webkit-details-marker { display:none; }
  .rate-menu-items { position:absolute; bottom:calc(100% + 8px); right:0; width:180px; display:grid; padding:var(--space-1); border:1px solid var(--pyric-border); border-radius:6px; background:var(--pyric-content); box-shadow:0 4px 16px #0005; }
  .rate-menu-items button { font:inherit; font-size:12px; padding:var(--space-2); text-align:left; border:0; color:var(--pyric-text); background:none; cursor:pointer; border-radius:3px; }
  .rate-menu-items button:hover,.rate-menu-items button:focus-visible { background:var(--pyric-bg); outline:1px solid var(--pyric-accent); }
  [data-history-toggle], .traffic-toolbar [data-rate-chart] { min-width:110px; }
  [data-capture-file] { display:none; }
  .capture-name-form { display:grid; grid-template-columns:60px minmax(0,1fr); align-items:center; gap:var(--space-3); padding:var(--space-3); background:var(--pyric-content); border:1px solid var(--pyric-border-soft); border-radius:8px; }
  .capture-name-form input { min-width:0; width:100%; box-sizing:border-box; font:inherit; color:var(--pyric-text); background:var(--pyric-bg); border:1px solid var(--pyric-border); border-radius:4px; padding:var(--space-2); }
  .capture-name { overflow-wrap:anywhere; }

  .rate-metadata { display:grid; grid-template-columns:4px minmax(0,1fr) auto 4px; gap:var(--space-2); margin:0; font-size:12px; }
  .rate-metadata dt { grid-column:2; color:var(--pyric-muted); }
  .rate-metadata dd { grid-column:3; margin:0; text-align:right; }
  .usage-services { display:grid; }
  .usage-service { display:grid; grid-template-columns:var(--space-2) minmax(0,1fr) var(--space-2); row-gap:var(--space-2); }
  .usage-service::before,.usage-service::after { content:""; grid-column:1 / -1; height:4px; }
  .usage-service + .usage-service { border-top:1px solid var(--pyric-border); }
  .usage-service > * { grid-column:2; }
  .usage-heading { display:flex; align-items:center; justify-content:space-between; gap:var(--space-2); min-height:32px; }
  .usage-heading h3,.usage-sdk-heading { margin:0; font-size:12px; font-weight:600; }
  .usage-heading span { font-size:11px; color:var(--pyric-muted); }
  .usage-heading button { font:inherit; color:var(--pyric-accent); background:none; border:0; padding:0; cursor:pointer; min-height:32px; }
  .usage-heading button:hover { text-decoration:underline; }
  .usage-heading button:focus-visible { outline:2px solid var(--pyric-accent); outline-offset:2px; }
  .usage-service dl { display:grid; gap:var(--space-2); margin:0; font-size:12px; }
  .usage-metric { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--space-2); align-items:baseline; }
  .usage-metric dt { color:var(--pyric-muted); }
  .usage-metric dd { margin:0; text-align:right; font-variant-numeric:tabular-nums; }
  .usage-gap { margin:0; font-size:11px; color:var(--pyric-muted); }
  .usage-notes { font-size:12px; }
  .usage-notes .usage-coverage { row-gap:var(--space-3); }
  .usage-notes-body { display:grid; grid-template-rows:0 auto 0; row-gap:var(--space-3); }
  .usage-notes-body > dl { grid-row:2; }
  .usage-coverage { display:grid; grid-template-columns:88px minmax(0,1fr); gap:var(--space-2); font-size:12px; margin:0; }
  .usage-coverage dt { color:var(--pyric-muted); }
  .usage-coverage dd { margin:0; line-height:1.5; }
  .usage-sdk-heading { min-height:32px; display:flex; align-items:flex-end; padding-inline:var(--record-inset); }
  .traffic-toolbar { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; }
`;

function rateNumber(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function metric(label: string, key: string, value: string): string {
  return `<div class="usage-metric"><dt>${label}</dt><dd class="mono" data-usage="${key}">${value}</dd></div>`;
}

function payloadRate(value: number): string {
  if (value >= 1024 * 1024) return `${rateNumber(value / (1024 * 1024))} MiB/s`;
  if (value >= 1024) return `${rateNumber(value / 1024)} KiB/s`;
  return `${rateNumber(value)} B/s`;
}

function operationRates(service: SdkServiceRate) {
  return {
    reads: service.methods.filter(method => method.category === 'read').reduce((sum, method) => sum + method.callsPerSecond, 0),
    writes: service.methods.filter(method => method.category === 'write' && (service.service !== 'storage' || method.method !== 'deleteObject')).reduce((sum, method) => sum + method.callsPerSecond, 0),
    deletes: service.methods.filter(method => method.method === 'deleteObject').reduce((sum, method) => sum + method.callsPerSecond, 0),
    deliveries: service.methods.filter(method => method.category === 'listener').reduce((sum, method) => sum + method.deliveriesPerSecond, 0),
  };
}

function serviceRow(service: SdkServiceRate, label: string, escape: Escape, interactive = true): string {
  const name = escape(label);
  const measured = service.coverage !== 'unsupported';
  const heading = measured && interactive ? `<button type="button" data-inspect-rates="${escape(service.service)}">${name}</button>` : name;
  const usage = service.usage;
  const number = (key: 'documentReads' | 'documentWrites' | 'documentDeletes') => usage ? rateNumber(usage[key]) : 'Not measured';
  let metrics = metric('Usage', 'unsupported', 'Not measured');
  if (service.service === 'firestore') {
    metrics = metric('Document reads/s', 'documentReads', number('documentReads'))
      + metric('Document writes/s', 'documentWrites', number('documentWrites'))
      + metric('Document deletes/s', 'documentDeletes', number('documentDeletes'))
      + metric('Other charges', 'excluded', 'Not measured');
  } else if (service.service === 'storage') {
    const operations = operationRates(service);
    metrics = metric('Reads/s', 'reads', rateNumber(operations.reads))
      + metric('Writes/s', 'writes', rateNumber(operations.writes))
      + metric('Deletes/s', 'deletes', rateNumber(operations.deletes))
      + metric('Uploaded/s', 'uploadedBytes', payloadRate(usage?.uploadedBytes ?? 0))
      + metric('Downloaded/s', 'downloadedBytes', payloadRate(usage?.downloadedBytes ?? 0));
  } else if (service.service === 'rtdb') {
    const operations = operationRates(service);
    metrics = metric('Reads/s', 'reads', rateNumber(operations.reads))
      + metric('Writes/s', 'writes', rateNumber(operations.writes))
      + metric('Listener deliveries/s', 'deliveries', rateNumber(operations.deliveries))
      + metric('Snapshot payload/s', 'payloadBytes', usage ? payloadRate(usage.payloadBytes) : 'Not measured')
      + metric('Billed downloads', 'excluded', 'Not measured')
      + metric('Stored data', 'storage', 'Not measured')
      + `<div class="usage-metric"><dt>Last activity</dt><dd data-last-activity>${service.lastActivityAt === undefined ? 'None recorded' : new Date(service.lastActivityAt).toLocaleTimeString()}</dd></div>`;
  }
  return `<section class="usage-service" data-rate-service="${escape(service.service)}"><div class="usage-heading"><h3>${heading}</h3>${measured ? `<span class="muted">${service.service !== 'firestore' ? 'Activity & volume' : 'Partial estimate'}</span>` : ''}</div><dl>${metrics}</dl>`
    + `<p class="usage-gap" data-usage-gap ${usage?.unmeasured ? '' : 'hidden'}>Some operations could not be measured.</p></section>`;
}

function coverage(service: string): string {
  return `<dl class="usage-coverage">${measurementNotes(service).map(note => `<dt>${note.label}</dt><dd>${note.text}</dd>`).join('')}</dl>`;
}

function methodRow(method: SdkMethodRate, escape: Escape, duration?: number): string {
  const name = escape(method.method);
  if (duration !== undefined) {
    return `<tr data-rate-method="${name}"><th scope="row"><code class="mono" tabindex="0" title="${name}">${name}</code></th>`
      + `<td class="mono" data-period-calls>${Math.round(method.callsPerSecond * duration)}</td>`
      + `<td class="mono" data-period-results>${method.category === 'write' ? '·' : Math.round(method.deliveriesPerSecond * duration)}</td>`
      + `<td class="mono" data-period-average>${rateNumber(method.category === 'listener' ? method.deliveriesPerSecond : method.callsPerSecond)}</td></tr>`;
  }
  let listening = '<span aria-label="Not a listener">·</span>';
  if (method.category === 'listener') listening = String(method.activeListeners);
  let results = '<span aria-label="No data result">·</span>';
  if (method.category !== 'write') results = rateNumber(method.deliveriesPerSecond);
  return `<tr data-rate-method="${name}"><th scope="row"><code class="mono" tabindex="0" title="${name}">${name}</code></th>`
    + `<td class="mono" data-rate-calls>${rateNumber(method.callsPerSecond)}</td>`
    + `<td class="mono" data-rate-results>${results}</td><td class="mono" data-rate-active>${listening}</td></tr>`;
}

function recordedFrame(snapshot: SdkRateSnapshot, service: SdkServiceRate): HistoryFrame | undefined {
  if (!service.history) return;
  const history = createRateHistory(service.service);
  const retained = { ...snapshot, monotonicAt: Math.max(snapshot.monotonicAt, (service.history.endSecond + 3) * 1000) };
  history.open(retained);
  return history.view(retained);
}
function activitySummary(snapshot: SdkRateSnapshot, service: SdkServiceRate): string {
  const frame = recordedFrame(snapshot, service);
  if (!frame) return 'No activity recorded';
  return `${rateNumber(frame.totals.reads)} ${service.service === 'firestore' ? 'document reads' : 'reads'} / ${rateNumber(frame.totals.writes)} writes${service.service === 'rtdb' ? ` / ${rateNumber(frame.totals.deliveries)} deliveries` : service.service === 'storage' ? ` / ${rateNumber(frame.totals.deletes)} deletes` : ''} in ${frame.duration}s`;
}
function serviceList(snapshot: SdkRateSnapshot, label: (service: string) => string, escape: Escape, incidents: ReadonlyMap<string, number>): string {
  return `<div class="rows rate-service-list">${snapshot.services.map(service => {
    const name = escape(label(service.service));
    if (service.coverage === 'unsupported') return `<div class="rate-service-item"><span>${name}<small>Not measured</small></span></div>`;
    const count = incidents.get(service.service) ?? 0;
    return `<div class="rate-service-item"><button type="button" data-inspect-rates="${escape(service.service)}" aria-label="${name}"><strong>${name}</strong><small data-service-summary="${escape(service.service)}">${activitySummary(snapshot, service)}</small></button>${count ? `<button type="button" class="rate-incident-count" data-rate-incidents="${escape(service.service)}">${count} ${count === 1 ? 'incident' : 'incidents'}</button>` : '<span class="rate-no-incidents">No incidents</span>'}</div>`;
  }).join('')}</div>`;
}

/** Service-specific usage leads; public SDK method counts remain diagnostic detail. */
export function rateView(
  snapshot: SdkRateSnapshot,
  selectedService: string | null,
  serviceLabel: (service: string) => string,
  escape: Escape,
  history?: HistoryFrame,
  chevron = '',
  incidents: ReadonlyMap<string, number> = new Map(),
  display: 'chart' | 'measurements' = 'chart',
): RateView {
  const service = snapshot.services.find(entry => entry.service === selectedService);
  const detail = history ? '' : `Last ${snapshot.windowSeconds} seconds`;
  if (!service || service.coverage === 'unsupported') {
    return { title: 'Services', detail: '', body: serviceList(snapshot, serviceLabel, escape, incidents) };
  }
  if (history && display === 'chart') return { title: '', detail: '', body: `<div class="rate-scope" data-rate-detail="${escape(service.service)}">${historyHtml(history)}</div>` };
  const listeners = service.methods.reduce((total, method) => total + method.activeListeners, 0);
  const untracked = service.untrackedMethods.map(method => `<tr data-rate-method="${escape(method)}"><th scope="row"><code class="mono">${escape(method)}</code></th><td colspan="3" class="rate-unavailable">Not measured</td></tr>`).join('');
  return {
    title: serviceLabel(service.service), detail,
    body: `<div class="rate-scope" data-rate-detail="${escape(service.service)}">`
      + (history ? '' : serviceRow(service, service.service === 'rtdb' ? 'Operations & data' : 'Usage estimate', escape, false))
      + `<dl class="rate-metadata"><dt>Scope</dt><dd>This page</dd>${service.service === 'storage' ? '' : `<dt>Listeners now</dt><dd data-rate-listeners>${listeners}</dd>`}</dl>`
      + `<h3 class="usage-sdk-heading">SDK activity${history ? ' · selected period' : ''}</h3><div class="rows"><table class="rate-table" aria-label="SDK activity by method"><colgroup><col class="rate-name"><col><col><col></colgroup><thead><tr><th scope="col">Method</th>${history ? '<th scope="col">Calls</th><th scope="col">Results</th><th scope="col">Avg/s</th>' : '<th scope="col" title="Includes denied attempts">Calls/s</th><th scope="col" title="Read results and listener callbacks">Results/s</th><th scope="col">Listening</th>'}</tr></thead><tbody>${(history ? history.service.methods : service.methods).map(method => methodRow(method, escape, history?.duration)).join('')}${untracked}</tbody></table></div>`
      + `<details class="rules-disclosure usage-notes" data-rate-notes="${escape(service.service)}"><summary><span>How measurements work</span><span class="rules-chevron">${chevron}</span></summary><div class="usage-notes-body">${coverage(service.service)}</div></details></div>`,
  };
}

function replaceNumber(root: ParentNode, selector: string, value: number): void {
  const element = root.querySelector(selector);
  const text = rateNumber(value);
  if (element && element.textContent !== text) element.textContent = text;
}

/** Refresh measurements without replacing focused controls or scrolled code. */
export function refreshRateView(root: ParentNode, snapshot: SdkRateSnapshot, history?: HistoryFrame): void {
  if (history) refreshHistory(root, history);
  for (const element of root.querySelectorAll<HTMLElement>('[data-service-summary]')) {
    const service = snapshot.services.find(service => service.service === element.dataset.serviceSummary);
    if (service) element.textContent = activitySummary(snapshot, service);
  }
  for (const row of root.querySelectorAll<HTMLElement>('[data-recorded-service]')) {
    const service = snapshot.services.find(service => service.service === row.dataset.recordedService);
    const frame = service && recordedFrame(snapshot, service);
    if (!frame) continue;
    for (const key of ['reads', 'writes', 'deletes', 'deliveries'] as const) replaceNumber(row, `[data-recorded-total="${key}"]`, frame.totals[key]);
    const duration = row.querySelector('[data-recorded-duration]');
    if (duration) duration.textContent = `${frame.duration}s recorded`;
  }
  for (const row of root.querySelectorAll<HTMLElement>('[data-rate-service]')) {
    const service = snapshot.services.find(entry => entry.service === row.dataset.rateService);
    if (!service || service.coverage === 'unsupported') continue;
    for (const key of ['documentReads', 'documentWrites', 'documentDeletes', 'payloadBytes', 'uploadedBytes', 'downloadedBytes'] as const) {
      const element = row.querySelector(`[data-usage="${key}"]`);
      const usage = service.usage;
      const text = usage ? (key.endsWith('Bytes') ? payloadRate(usage[key] ?? 0) : rateNumber(usage[key] ?? 0)) : 'Not measured';
      if (element && element.textContent !== text) element.textContent = text;
    }
    if (service.service === 'rtdb' || service.service === 'storage') {
      for (const [key, value] of Object.entries(operationRates(service))) replaceNumber(row, `[data-usage="${key}"]`, value);
    }
    const last = row.querySelector('[data-last-activity]');
    if (last) last.textContent = service.lastActivityAt === undefined ? 'None recorded' : new Date(service.lastActivityAt).toLocaleTimeString();
    const gap = row.querySelector<HTMLElement>('[data-usage-gap]');
    if (gap) gap.hidden = !service.usage?.unmeasured;
  }
  const detail = root.querySelector<HTMLElement>('[data-rate-detail]');
  const service = history ? history.service : snapshot.services.find(entry => entry.service === detail?.dataset.rateDetail);
  if (!detail || !service) return;
  replaceNumber(detail, '[data-rate-listeners]', (snapshot.services.find(entry => entry.service === service.service)?.methods ?? []).reduce((total, method) => total + method.activeListeners, 0));
  for (const row of detail.querySelectorAll<HTMLElement>('[data-rate-method]')) {
    const method = service.methods.find(entry => entry.method === row.dataset.rateMethod);
    if (!method) continue;
    if (history) {
      replaceNumber(row, '[data-period-calls]', Math.round(method.callsPerSecond * history.duration));
      if (method.category !== 'write') replaceNumber(row, '[data-period-results]', Math.round(method.deliveriesPerSecond * history.duration));
      replaceNumber(row, '[data-period-average]', method.category === 'listener' ? method.deliveriesPerSecond : method.callsPerSecond);
    }
    replaceNumber(row, '[data-rate-calls]', method.callsPerSecond);
    if (method.category !== 'write') replaceNumber(row, '[data-rate-results]', method.deliveriesPerSecond);
    if (method.category === 'listener') replaceNumber(row, '[data-rate-active]', method.activeListeners);
  }
}
