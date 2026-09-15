import { createRateHistoryArchive } from './rate-history-archive.js';
import type { RateIncident } from './rate-threshold-monitor.js';
import type { SdkMethodRate, SdkRateSnapshot, SdkServiceRate } from 'pyric/sandbox/internal';

type Counts = { reads: number; writes: number; deliveries: number; deletes: number; uploadedBytes?: number; downloadedBytes?: number };
const keys = ['reads', 'writes', 'deliveries', 'deletes'] as const;
const visibleKeys = (service: string) => service !== 'rtdb' ? ['reads', 'writes', 'deletes'] as const : ['reads', 'writes', 'deliveries'] as const;
const labels = { reads: 'Reads', writes: 'Writes', deliveries: 'Deliveries', deletes: 'Deletes' };
export interface HistoryFrame {
  readonly service: SdkServiceRate;
  readonly points: readonly (Counts & { second: number })[];
  readonly from: number;
  readonly to: number;
  readonly paused: boolean;
  readonly totals: Counts;
  readonly peaks: Counts;
  readonly duration: number;
  readonly clockOffset: number;
  readonly incident?: RateIncident;
  readonly imported?: boolean;
  readonly timeline?: { from: number; to: number; window: number };
  readonly warnings?: readonly { from: number; to: number }[];
}
function pointsFor(methods: readonly SdkMethodRate[], from: number, to: number, service: SdkServiceRate, retained = false): Array<Counts & { second: number }> {
  const usage = new Map((retained ? service.history?.usageBuckets : service.usageBuckets)?.map(bucket => [bucket.second, bucket]));
  const indexedMethods = methods.map(method => ({ method: method.method, category: method.category, buckets: new Map(method.buckets.map(bucket => [bucket.second, bucket])) }));
  return Array.from({ length: Math.max(1, to - from + 1) }, (_, index) => {
    const second = from + index;
    const counts = { second, reads: 0, writes: 0, deliveries: 0, deletes: 0 };
    if (service.service === 'firestore') {
      const bucket = usage.get(second);
      return { ...counts, reads: bucket?.documentReads ?? 0, writes: bucket?.documentWrites ?? 0, deletes: bucket?.documentDeletes ?? 0 };
    }
    for (const method of indexedMethods) {
      const bucket = method.buckets.get(second);
      if (!bucket) continue;
      if (method.category === 'listener') counts.deliveries += bucket.deliveries;
      else if (method.category === 'read') counts.reads += bucket.calls;
      else if (service.service === 'storage' && method.method === 'deleteObject') counts.deletes += bucket.calls;
      else counts.writes += bucket.calls;
    }
    return service.service === 'storage' ? { ...counts, uploadedBytes: usage.get(second)?.uploadedBytes ?? 0, downloadedBytes: usage.get(second)?.downloadedBytes ?? 0 } : counts;
  });
}
function active(point: Counts) { return keys.some(key => point[key] > 0) || (point.uploadedBytes ?? 0) > 0 || (point.downloadedBytes ?? 0) > 0; }

/** Selection owns an immutable capture, so live events cannot move its evidence. */
export function createRateHistory(serviceName = 'rtdb') {
  const archive = createRateHistoryArchive(serviceName);
  let windowSeconds = 60;
  let viewport: [number, number] | undefined;
  let imported: HistoryFrame | undefined;
  let captured: SdkServiceRate | undefined;
  // Pin the browsable archive as well as the selected window until live resumes.
  let pausedNavigation: { bounds: ReturnType<typeof archive.bounds>; source: SdkServiceRate | undefined } | undefined;
  function navigation() {
    return pausedNavigation ??= { bounds: { ...archive.bounds() }, source: archive.source() };
  }
  let interval: [number, number] | undefined;
  let incident: RateIncident | undefined;
  let forceLive = false;
  let manual = false;
  let warnings: readonly { from: number; to: number }[] = [];
  function view(snapshot: SdkRateSnapshot): HistoryFrame | undefined {
    archive.record(snapshot);
    if (imported) return imported;
    const service = captured ?? (windowSeconds > 60 ? archive.source() : snapshot.services.find(service => service.service === serviceName));
    if (!service) return;
    const end = viewport?.[1] ?? (captured ? service.history?.endSecond ?? Math.floor(snapshot.monotonicAt / 1000) : Math.floor(snapshot.monotonicAt / 1000));
    const start = viewport?.[0] ?? Math.max(service.history?.startedSecond ?? end - windowSeconds + 1, end - windowSeconds + 1);
    const methods = captured ? service.history?.methods ?? service.methods : service.methods;
    const points = pointsFor(methods, start, end, service, !!captured);
    const [from, to] = interval ?? [start, end];
    const duration = to - from + 1;
    const selected = points.filter(point => point.second >= from && point.second <= to);
    const totals: Counts = { reads: 0, writes: 0, deliveries: 0, deletes: 0 };
    const peaks: Counts = { reads: 0, writes: 0, deliveries: 0, deletes: 0 };
    for (const point of selected) for (const key of keys) { totals[key] += point[key]; peaks[key] = Math.max(peaks[key], point[key]); }
    if (service.service === 'storage') for (const key of ['uploadedBytes', 'downloadedBytes'] as const) {
      totals[key] = selected.reduce((sum, point) => sum + (point[key] ?? 0), 0);
      peaks[key] = Math.max(0, ...selected.map(point => point[key] ?? 0));
    }
    const projected = methods.map(method => {
      const buckets = method.buckets.filter(bucket => bucket.second >= from && bucket.second <= to);
      return { ...method, callsPerSecond: buckets.reduce((sum, bucket) => sum + bucket.calls, 0) / duration,
        deliveriesPerSecond: buckets.reduce((sum, bucket) => sum + bucket.deliveries, 0) / duration };
    });
    const clockOffset = (captured ? navigation().bounds : archive.bounds()).clockOffset ?? Date.now() - snapshot.monotonicAt;
    return { service: { ...service, methods: projected }, points, from, to, paused: !!captured, totals, peaks, duration, clockOffset, warnings, incident, timeline: { ...(captured ? navigation().bounds : archive.bounds()), window: windowSeconds } };
  }
  function pause(snapshot: SdkRateSnapshot, latest = false) {
    archive.record(snapshot);
    pausedNavigation = undefined;
    navigation();
    viewport = undefined;
    const source = snapshot.services.find(service => service.service === serviceName);
    captured = latest || !source ? source : { ...source, history: { endSecond: Math.floor(snapshot.monotonicAt / 1000), startedSecond: source.history?.startedSecond ?? 0, methods: source.methods, usageBuckets: source.usageBuckets } };
    interval = undefined;
    if (latest) {
      const points = view(snapshot)?.points ?? [];
      const used = points.filter(active);
      const last = used.at(-1);
      if (last) {
        let first = last.second;
        for (let i = used.length - 2; i >= 0 && first - used[i]!.second <= 2; i--) first = used[i]!.second;
        interval = [first, last.second];
      }
    }
  }
  function pan(snapshot: SdkRateSnapshot, start: number) {
    if (imported) return;
    archive.record(snapshot);
    const frozen = navigation();
    const bounds = frozen.bounds;
    const from = Math.max(bounds.from, Math.min(start, Math.max(bounds.from, bounds.to - windowSeconds + 1)));
    captured = frozen.source;
    viewport = [from, Math.min(bounds.to, from + windowSeconds - 1)];
    interval = [...viewport]; incident = undefined; manual = true;
  }
  return {
    view,
    load(frame: HistoryFrame) { imported = { ...structuredClone(frame), imported: true, paused: true }; },
    record: archive.record,
    pan,
    zoom(snapshot: SdkRateSnapshot, factor: number) {
      if (imported) return;
      const frame = view(snapshot);
      if (!frame) return;
      const center = (frame.points[0]!.second + frame.points.at(-1)!.second) / 2;
      windowSeconds = Math.max(10, Math.min(1800, Math.round(windowSeconds * factor)));
      pan(snapshot, Math.round(center - (windowSeconds - 1) / 2));
    },
    markWarnings(next: readonly { from: number; to: number }[]) { warnings = next; },
    inspect(snapshot: SdkRateSnapshot, from: number, to: number, selectedIncident?: RateIncident) {
      if (snapshot.monotonicAt / 1000 >= archive.bounds().to) archive.record(snapshot);
      pausedNavigation = undefined;
      navigation();
      viewport = undefined;
      incident = selectedIncident ? structuredClone(selectedIncident) : undefined;
      captured = snapshot.services.find(service => service.service === serviceName);
      manual = true;
      const end = captured?.history?.endSecond ?? to;
      interval = [Math.max(from, end - 59, captured?.history?.startedSecond ?? 0), Math.min(to, end)];
    },
    open(snapshot: SdkRateSnapshot) {
      if (forceLive || manual) return;
      pausedNavigation = undefined;
      viewport = undefined; captured = undefined; interval = undefined;
      const service = snapshot.services.find(service => service.service === serviceName);
      const history = service?.history;
      const last = history ? pointsFor(history.methods, history.endSecond - 59, history.endSecond, service, true).filter(active).at(-1) : undefined;
      if (last && Math.floor(snapshot.monotonicAt / 1000) - last.second >= 2) pause(snapshot, true);
    },
    pause: (snapshot: SdkRateSnapshot) => { if (imported) return; incident = undefined; manual = true; pause(snapshot); },
    live() {
      imported = undefined; pausedNavigation = undefined;
      incident = undefined; viewport = undefined; captured = undefined; interval = undefined; forceLive = true;
    },
    select(snapshot: SdkRateSnapshot, start: number, end: number) {
      if (imported) return;
      incident = undefined;
      manual = true;
      if (!captured) {
        // Capture the currently displayed live minute, not the idle-anchored window.
        const source = snapshot.services.find(service => service.service === serviceName);
        if (source) captured = { ...source, history: { endSecond: Math.floor(snapshot.monotonicAt / 1000), startedSecond: source.history?.startedSecond ?? 0, methods: source.methods, usageBuckets: source.usageBuckets } };
      }
      const frame = view(snapshot);
      if (!frame) return;
      const low = frame.points[0]!.second, high = frame.points.at(-1)!.second;
      const clamp = (value: number) => Math.max(low, Math.min(high, value));
      interval = [clamp(Math.min(start, end)), clamp(Math.max(start, end))];
    },
  };
}
const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const time = (frame: HistoryFrame, second: number) => new Date(frame.clockOffset + second * 1000).toLocaleTimeString([], { hour12: false });
function graphic(frame: HistoryFrame) {
  const maximum = Math.max(1, ...frame.points.flatMap(point => visibleKeys(frame.service.service).map(key => point[key])));
  const width = 600, height = 90, step = width / frame.points.length;
  const left = (frame.from - frame.points[0]!.second) * step;
  const first = frame.points[0]!.second;
  const last = frame.points.at(-1)!.second;
  const warnings = (frame.warnings ?? []).filter(warning => warning.to >= first && warning.from <= last).map(warning => `<rect class="history-warning" x="${(Math.max(first, warning.from) - first) * step}" y="0" width="${(Math.min(last, warning.to) - Math.max(first, warning.from) + 1) * step}" height="90"/>`).join('');
  const paths = visibleKeys(frame.service.service).map(key => `<polyline class="history-${key}${incidentKey(frame) === key ? ' history-trigger' : ''}" points="${frame.points.map((point, index) => `${index * step + step / 2},${height - point[key] / maximum * (height - 6)}`).join(' ')}"/>`).join('');
  return `<svg viewBox="0 0 600 96" preserveAspectRatio="none" aria-hidden="true">${warnings}<rect class="history-selection" x="${left}" y="0" width="${frame.duration * step}" height="90"/>${paths}</svg><span class="history-scale">${maximum}/s</span>`;
}
function incidentKey(frame: HistoryFrame): typeof keys[number] | undefined {
  const operation = frame.incident?.operation;
  if (operation === 'documentReads') return 'reads';
  if (operation === 'documentWrites') return 'writes';
  if (operation === 'documentDeletes') return 'deletes';
  return operation;
}
function incidentContext(frame: HistoryFrame): string {
  const incident = frame.incident;
  const key = incidentKey(frame);
  if (!incident || !key) return '';
  const fact = (label: string, value: string) => `<dt>${label}</dt><dd>${value}</dd>`;
  return `<div class="rows history-incident"><strong>${incident.label} exceeded your limit</strong><p>${labels[key]} stayed above your ${number(incident.limit)}/s limit for at least ${incident.sustainedSeconds} seconds.</p><dl>${fact('Recorded volume', `${number(frame.totals[key])} ${incident.label.toLowerCase()} in ${frame.duration} seconds`)}${fact('Limit', `${number(incident.limit)}/s`)}${fact('Peak', `${number(incident.peak)}/s (${number(incident.peak / incident.limit)}× limit)`)}${fact('Time above limit', `${incident.aboveSeconds} seconds`)}${fact('Elapsed time', `${incident.to - incident.from + 1} seconds`)}</dl></div>`;
}
function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(value || 1) / 10)));
  const scaled = value / 1024 ** unit;
  return `${scaled.toLocaleString('en-US', { maximumFractionDigits: scaled >= 100 ? 0 : 1 })}&nbsp;${units[unit]}`;
}
function summary(frame: HistoryFrame) {
  return `<div class="history-summary-heading"><div><strong>${frame.paused ? 'Selected period' : 'Live period'}</strong><div class="history-period-time"><span>${time(frame, frame.from)} to ${time(frame, frame.to + 1)}</span><span class="history-duration">${frame.duration}s</span></div></div></div>`
    + `<table class="rate-table" aria-label="Operations in selected period"><thead><tr><th>Operation</th><th>Total</th><th>Avg/s</th><th>Peak/s</th></tr></thead><tbody>${visibleKeys(frame.service.service).map(key => `<tr${incidentKey(frame) === key ? ' class="history-trigger-row"' : ''}><th>${labels[key]}</th><td class="mono" data-history-total="${key}">${number(frame.totals[key])}</td><td class="mono">${number(frame.totals[key] / frame.duration)}</td><td class="mono">${number(frame.peaks[key])}</td></tr>`).join('')}${frame.service.service === 'storage' ? (['uploadedBytes', 'downloadedBytes'] as const).map(key => `<tr><th>${key === 'uploadedBytes' ? 'Uploaded bytes' : 'Downloaded bytes'}</th><td class="mono">${bytes(frame.totals[key] ?? 0)}</td><td class="mono">${bytes((frame.totals[key] ?? 0) / frame.duration)}</td><td class="mono">${bytes(frame.peaks[key] ?? 0)}</td></tr>`).join('') : ''}</tbody></table>`;
}
function timelineHtml(frame: HistoryFrame): string {
  if (frame.imported) return '<p class="history-help">Saved capture. Live returns to this page.</p>';
  const bounds = frame.timeline ?? { from: frame.points[0]!.second, to: frame.points.at(-1)!.second, window: 60 };
  return `<div class="history-timeline"><div class="history-zoom"><strong title="Up to 30 minutes retained on this page">Timeline</strong><span data-timeline-window>${bounds.window}s view</span><button type="button" class="btn" data-history-zoom="2" aria-label="Zoom out"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8h10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button><button type="button" class="btn" data-history-zoom="0.5" aria-label="Zoom in"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8h10M8 3v10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button></div><input type="range" data-history-scrubber aria-label="Timeline position" min="${bounds.from}" max="${Math.max(bounds.from, bounds.to - bounds.window + 1)}" value="${frame.points[0]!.second}" step="1"><div class="history-axis" data-timeline-bounds><span>${time(frame, bounds.from)}</span><span>${time(frame, bounds.to + 1)}</span></div></div>`;
}
export function historyHtml(frame: HistoryFrame): string {
  return `<section class="rate-history"><div data-incident-context>${incidentContext(frame)}</div><div class="history-period"><strong>${frame.service.service === 'firestore' ? 'Document estimates per second' : 'Operations per second'}</strong><span>1-second buckets</span></div><div class="history-legend" data-incident-operation="${incidentKey(frame) ?? ''}"><span class="history-reads">Reads</span><span class="history-writes">Writes</span><span class="history-deliveries">${frame.service.service !== 'rtdb' ? 'Deletes' : 'Deliveries'}</span></div><div class="history-chart" data-history-chart tabindex="${frame.imported ? -1 : 0}" aria-disabled="${frame.imported === true}" role="slider" aria-label="Activity period" aria-valuemin="${frame.points[0]!.second}" aria-valuemax="${frame.points.at(-1)!.second}" aria-valuenow="${frame.to}" aria-valuetext="${time(frame, frame.from)} to ${time(frame, frame.to + 1)}" aria-describedby="history-help">${graphic(frame)}</div><div class="history-axis" data-history-axis><span>${time(frame, frame.points[0]!.second)}</span><span>${time(frame, frame.points.at(-1)!.second + 1)}</span></div>${timelineHtml(frame)}<p class="sr-only" id="history-help">Drag or use arrow keys to select. Shift extends the period.</p><div class="rows" data-history-summary>${summary(frame)}</div></section>`;
}
export function refreshHistory(root: ParentNode, frame: HistoryFrame) {
  const chart = root.querySelector<HTMLElement>('[data-history-chart]');
  if (!chart) return;
  const scrubber = root.querySelector<HTMLInputElement>('[data-history-scrubber]');
  if (scrubber && frame.timeline) {
    scrubber.min = String(frame.timeline.from);
    scrubber.max = String(Math.max(frame.timeline.from, frame.timeline.to - frame.timeline.window + 1));
    scrubber.value = String(frame.points[0]!.second);
    scrubber.setAttribute('aria-valuetext', `${time(frame, frame.points[0]!.second)} to ${time(frame, frame.points.at(-1)!.second + 1)}`);
    const bounds = root.querySelector('[data-timeline-bounds]');
    if (bounds) bounds.innerHTML = `<span>${time(frame, frame.timeline.from)}</span><span>${time(frame, frame.timeline.to + 1)}</span>`;
    const window = root.querySelector('[data-timeline-window]');
    if (window) window.textContent = `${frame.timeline.window}s view`;
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-history-zoom]')) button.disabled = Number(button.dataset.historyZoom) > 1 ? frame.timeline.window >= 1800 : frame.timeline.window <= 10;
  }
  const context = root.querySelector('[data-incident-context]');
  if (context) context.innerHTML = incidentContext(frame);
  root.querySelector('.history-legend')?.setAttribute('data-incident-operation', incidentKey(frame) ?? '');
  chart.innerHTML = graphic(frame);
  chart.setAttribute('aria-valuemin', String(frame.points[0]!.second));
  chart.setAttribute('aria-valuemax', String(frame.points.at(-1)!.second));
  chart.setAttribute('aria-valuenow', String(frame.to));
  chart.setAttribute('aria-valuetext', `${time(frame, frame.from)} to ${time(frame, frame.to + 1)}`);
  const axis = root.querySelector('[data-history-axis]');
  if (axis) axis.innerHTML = `<span>${time(frame, frame.points[0]!.second)}</span><span>${time(frame, frame.points.at(-1)!.second + 1)}</span>`;
  const summaryElement = root.querySelector('[data-history-summary]');
  if (summaryElement) summaryElement.innerHTML = summary(frame);
  for (const button of root.querySelectorAll<HTMLElement>('[data-history-mode]')) {
    if (button.hasAttribute('data-history-toggle')) { button.dataset.historyMode = frame.paused ? 'live' : 'pause'; button.textContent = frame.imported ? 'Return to live' : frame.paused ? 'Resume live' : 'Pause'; }
    else button.setAttribute('aria-pressed', String(button.dataset.historyMode === (frame.paused ? 'pause' : 'live')));
  }
}
export function bindHistory(root: ParentNode, state: ReturnType<typeof createRateHistory>, snapshot: () => SdkRateSnapshot, changed: () => void) {
  const chart = root.querySelector<HTMLElement>('[data-history-chart]');
  if (!chart) return;
  root.querySelector<HTMLInputElement>('[data-history-scrubber]')?.addEventListener('input', event => {
    state.pan(snapshot(), Number((event.currentTarget as HTMLInputElement).value)); changed();
  });
  for (const button of root.querySelectorAll<HTMLElement>('[data-history-zoom]')) button.addEventListener('click', () => {
    state.zoom(snapshot(), Number(button.dataset.historyZoom)); changed();
  });
  let anchor: number | undefined;
  let keyCursor: number | undefined;
  let keyAnchor: number | undefined;
  function second(event: PointerEvent) {
    const frame = state.view(snapshot())!;
    const rect = chart!.getBoundingClientRect();
    const index = Math.max(0, Math.min(frame.points.length - 1, Math.floor((event.clientX - rect.left) / rect.width * frame.points.length)));
    return frame.points[index]!.second;
  }
  chart.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); chart.focus(); keyCursor = undefined; keyAnchor = undefined; anchor = second(event); state.select(snapshot(), anchor, anchor); chart.setPointerCapture(event.pointerId); changed(); });
  chart.addEventListener('pointermove', event => { if (anchor === undefined) return; state.select(snapshot(), anchor, second(event)); changed(); });
  const end = () => { anchor = undefined; };
  chart.addEventListener('pointerup', end); chart.addEventListener('pointercancel', end);
  chart.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const frame = state.view(snapshot())!;
    const low = frame.points[0]!.second, high = frame.points.at(-1)!.second;
    const to = event.key === 'Home' ? low : event.key === 'End' ? high : Math.max(low, Math.min(high, (keyCursor ?? frame.to) + (event.key === 'ArrowLeft' ? -1 : 1)));
    keyAnchor = event.shiftKey ? keyAnchor ?? frame.to : to;
    keyCursor = to;
    state.select(snapshot(), keyAnchor, to); changed();
  });
}
export const HISTORY_STYLES = `
.rate-history { display:grid; grid-template-columns:var(--record-inset) minmax(0,1fr) var(--record-inset); row-gap:var(--space-2); }
.rate-history > * { grid-column:2; min-width:0; }
.rate-history > .rows { grid-column:1 / -1; }
.rate-history .rate-table th,.rate-history .rate-table td { min-height:28px; }
.history-timeline { display:grid; gap:var(--space-2); border-top:1px solid var(--pyric-border-soft); padding-top:var(--space-2); }
.history-zoom { display:grid; grid-template-columns:1fr auto 32px 32px; gap:var(--space-2); align-items:center; font-size:11px; }
.history-zoom span { color:var(--pyric-muted); font-variant-numeric:tabular-nums; }
.history-zoom .btn { min-width:0; width:32px; padding:0; }
.history-timeline input { appearance:none; width:100%; margin:0; background:transparent; min-height:28px; padding:0; border:0; cursor:ew-resize; }
.history-timeline input::-webkit-slider-runnable-track { height:4px; background:var(--pyric-border); border-radius:2px; }
.history-timeline input::-webkit-slider-thumb { appearance:none; width:14px; height:14px; margin-top:-5px; border-radius:50%; background:var(--pyric-accent); }
.history-timeline input::-moz-range-track { height:4px; background:var(--pyric-border); border-radius:2px; }
.history-timeline input::-moz-range-thumb { width:14px; height:14px; border:0; border-radius:50%; background:var(--pyric-accent); }
.history-timeline input:focus-visible { outline:2px solid var(--pyric-accent); outline-offset:2px; }
.history-incident { padding:var(--space-3); font-size:12px; }
.history-incident p { margin:var(--space-2) 0; color:var(--pyric-muted); line-height:1.5; }
.history-incident dl { display:grid; grid-template-columns:auto minmax(0,1fr); gap:var(--space-2); margin:var(--space-3) 0 0; }
.history-incident dt { color:var(--pyric-muted); }
.history-incident dd { margin:0; text-align:right; font-variant-numeric:tabular-nums; }
.history-legend[data-incident-operation="reads"] .history-reads,.history-legend[data-incident-operation="writes"] .history-writes,.history-legend[data-incident-operation="deliveries"] .history-deliveries,.history-legend[data-incident-operation="deletes"] .history-deliveries { color:var(--pyric-warning); }
.history-trigger-row { background:color-mix(in srgb,var(--pyric-warning) 8%,transparent); }
.history-chart .history-trigger { stroke:var(--pyric-warning); stroke-width:3; }
[data-incident-context]:empty { display:none; }
.history-period,.history-axis,.history-legend { display:flex; justify-content:space-between; gap:var(--space-2); font-size:11px; }
.history-period { flex-wrap:wrap; }
.history-warning { fill:var(--pyric-warning); fill-opacity:0.16; }
.history-summary-heading { display:grid; grid-template-columns:4px minmax(0,1fr) 4px; column-gap:var(--space-2); font-size:11px; }
.history-summary-heading > div { grid-column:2; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--space-2); min-height:36px; }
.history-period-time { display:flex; flex:1; align-items:baseline; justify-content:flex-end; gap:12px; color:var(--pyric-muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
.history-duration { min-width:3ch; text-align:right; }
.history-period span,.history-axis,.history-help[hidden] { display:none; }
.history-help { color:var(--pyric-muted); }
.history-chart { position:relative; height:64px; touch-action:none; cursor:crosshair; border-bottom:1px solid var(--pyric-border); }
.history-chart:focus-visible { outline:2px solid var(--pyric-accent); outline-offset:2px; }
.history-chart svg { display:block; width:100%; height:100%; pointer-events:none; }
.history-chart polyline { fill:none; stroke:currentColor; stroke-width:2; vector-effect:non-scaling-stroke; }
.history-reads { color:var(--pyric-accent); }
.history-writes { color:var(--pyric-text); stroke-dasharray:5 3; }
.history-deliveries,.history-deletes { color:var(--pyric-muted); stroke-dasharray:2 3; }
.history-selection { fill:var(--pyric-accent); opacity:0.12; }
.history-scale { position:absolute; right:0; top:0; color:var(--pyric-muted); font-size:10px; }
.history-help[hidden] { display:none; }
.history-help { margin:0; font-size:11px; line-height:1.5; }
.history-legend span { display:inline-flex; align-items:center; gap:4px; }
.history-legend span::before { content:""; display:inline-block; width:12px; border-top:2px solid currentColor; }
.history-legend .history-writes::before { border-top-style:dashed; }
.history-legend .history-deliveries::before { border-top-style:dotted; }
`;
