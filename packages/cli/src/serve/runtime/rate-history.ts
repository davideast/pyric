import type { SdkMethodRate, SdkRateSnapshot, SdkServiceRate } from 'pyric/sandbox/internal';

type Counts = { reads: number; writes: number; deliveries: number; deletes: number };
const keys = ['reads', 'writes', 'deliveries', 'deletes'] as const;
const visibleKeys = (service: string) => service === 'firestore' ? ['reads', 'writes', 'deletes'] as const : ['reads', 'writes', 'deliveries'] as const;
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
}
function pointsFor(methods: readonly SdkMethodRate[], from: number, to: number, service: SdkServiceRate, retained = false) {
  return Array.from({ length: Math.max(1, to - from + 1) }, (_, index) => {
    const second = from + index;
    const counts = { second, reads: 0, writes: 0, deliveries: 0, deletes: 0 };
    if (service.service === 'firestore') {
      const bucket = (retained ? service.history?.usageBuckets : service.usageBuckets)?.find(bucket => bucket.second === second);
      return { ...counts, reads: bucket?.documentReads ?? 0, writes: bucket?.documentWrites ?? 0, deletes: bucket?.documentDeletes ?? 0 };
    }
    for (const method of methods) {
      const bucket = method.buckets.find(bucket => bucket.second === second);
      if (!bucket) continue;
      if (method.category === 'listener') counts.deliveries += bucket.deliveries;
      else if (method.category === 'read') counts.reads += bucket.calls;
      else counts.writes += bucket.calls;
    }
    return counts;
  });
}
function active(point: Counts) { return keys.some(key => point[key] > 0); }

/** Selection owns an immutable capture, so live events cannot move its evidence. */
export function createRateHistory(serviceName = 'rtdb') {
  let captured: SdkServiceRate | undefined;
  let interval: [number, number] | undefined;
  let forceLive = false;
  let manual = false;
  function view(snapshot: SdkRateSnapshot): HistoryFrame | undefined {
    const service = captured ?? snapshot.services.find(service => service.service === serviceName);
    if (!service) return;
    const end = captured ? service.history?.endSecond ?? Math.floor(snapshot.monotonicAt / 1000) : Math.floor(snapshot.monotonicAt / 1000);
    const start = Math.max(service.history?.startedSecond ?? end - 59, end - 59);
    const methods = captured ? service.history?.methods ?? service.methods : service.methods;
    const points = pointsFor(methods, start, end, service, !!captured);
    const [from, to] = interval ?? [start, end];
    const duration = to - from + 1;
    const selected = points.filter(point => point.second >= from && point.second <= to);
    const totals: Counts = { reads: 0, writes: 0, deliveries: 0, deletes: 0 };
    const peaks: Counts = { reads: 0, writes: 0, deliveries: 0, deletes: 0 };
    for (const point of selected) for (const key of keys) { totals[key] += point[key]; peaks[key] = Math.max(peaks[key], point[key]); }
    const projected = methods.map(method => {
      const buckets = method.buckets.filter(bucket => bucket.second >= from && bucket.second <= to);
      return { ...method, callsPerSecond: buckets.reduce((sum, bucket) => sum + bucket.calls, 0) / duration,
        deliveriesPerSecond: buckets.reduce((sum, bucket) => sum + bucket.deliveries, 0) / duration };
    });
    const retained = pointsFor(service.history?.methods ?? service.methods, service.history ? service.history.endSecond - 59 : start, service.history?.endSecond ?? end, service, true);
    const last = retained.filter(active).at(-1)?.second;
    const clockOffset = last !== undefined && service.lastActivityAt !== undefined ? service.lastActivityAt - last * 1000 : Date.now() - snapshot.monotonicAt;
    return { service: { ...service, methods: projected }, points, from, to, paused: !!captured, totals, peaks, duration, clockOffset };
  }
  function pause(snapshot: SdkRateSnapshot, latest = false) {
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
  return {
    view,
    open(snapshot: SdkRateSnapshot) {
      if (forceLive || manual) return;
      captured = undefined; interval = undefined;
      const service = snapshot.services.find(service => service.service === serviceName);
      const history = service?.history;
      const last = history ? pointsFor(history.methods, history.endSecond - 59, history.endSecond, service, true).filter(active).at(-1) : undefined;
      if (last && Math.floor(snapshot.monotonicAt / 1000) - last.second >= 2) pause(snapshot, true);
    },
    pause: (snapshot: SdkRateSnapshot) => { manual = true; pause(snapshot); },
    live() { captured = undefined; interval = undefined; forceLive = true; },
    select(snapshot: SdkRateSnapshot, start: number, end: number) {
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
  const paths = visibleKeys(frame.service.service).map(key => `<polyline class="history-${key}" points="${frame.points.map((point, index) => `${index * step + step / 2},${height - point[key] / maximum * (height - 6)}`).join(' ')}"/>`).join('');
  return `<svg viewBox="0 0 600 96" preserveAspectRatio="none" aria-hidden="true"><rect class="history-selection" x="${left}" y="0" width="${frame.duration * step}" height="90"/>${paths}</svg><span class="history-scale">${maximum}/s</span>`;
}
function summary(frame: HistoryFrame) {
  return `<div class="history-summary-heading"><div><strong>${frame.paused ? 'Selected period' : 'Live period'}</strong><div class="history-period-time"><span>${time(frame, frame.from)} to ${time(frame, frame.to + 1)}</span><span class="history-duration">${frame.duration}s</span></div></div></div>`
    + `<table class="rate-table" aria-label="Operations in selected period"><thead><tr><th>Operation</th><th>Total</th><th>Avg/s</th><th>Peak/s</th></tr></thead><tbody>${visibleKeys(frame.service.service).map(key => `<tr><th>${labels[key]}</th><td class="mono" data-history-total="${key}">${number(frame.totals[key])}</td><td class="mono">${number(frame.totals[key] / frame.duration)}</td><td class="mono">${number(frame.peaks[key])}</td></tr>`).join('')}</tbody></table>`;
}
export function historyHtml(frame: HistoryFrame): string {
  return `<section class="rate-history"><div class="history-period"><strong>${frame.service.service === 'firestore' ? 'Document estimates per second' : 'Operations per second'}</strong><span>1-second buckets</span></div><div class="history-legend"><span class="history-reads">Reads</span><span class="history-writes">Writes</span><span class="history-deliveries">${frame.service.service === 'firestore' ? 'Deletes' : 'Deliveries'}</span></div><div class="history-chart" data-history-chart tabindex="0" role="slider" aria-label="Activity period" aria-valuemin="${frame.points[0]!.second}" aria-valuemax="${frame.points.at(-1)!.second}" aria-valuenow="${frame.to}" aria-valuetext="${time(frame, frame.from)} to ${time(frame, frame.to + 1)}" aria-describedby="history-help">${graphic(frame)}</div><div class="history-axis" data-history-axis><span>${time(frame, frame.points[0]!.second)}</span><span>${time(frame, frame.points.at(-1)!.second + 1)}</span></div><p class="history-help" id="history-help">Drag or use arrow keys to select. Shift extends the period.</p><div class="rows" data-history-summary>${summary(frame)}</div></section>`;
}
export function refreshHistory(root: ParentNode, frame: HistoryFrame) {
  const chart = root.querySelector<HTMLElement>('[data-history-chart]');
  if (!chart) return;
  chart.innerHTML = graphic(frame);
  chart.setAttribute('aria-valuemin', String(frame.points[0]!.second));
  chart.setAttribute('aria-valuemax', String(frame.points.at(-1)!.second));
  chart.setAttribute('aria-valuenow', String(frame.to));
  chart.setAttribute('aria-valuetext', `${time(frame, frame.from)} to ${time(frame, frame.to + 1)}`);
  const axis = root.querySelector('[data-history-axis]');
  if (axis) axis.innerHTML = `<span>${time(frame, frame.points[0]!.second)}</span><span>${time(frame, frame.points.at(-1)!.second + 1)}</span>`;
  const summaryElement = root.querySelector('[data-history-summary]');
  if (summaryElement) summaryElement.innerHTML = summary(frame);
  for (const button of root.querySelectorAll<HTMLElement>('[data-history-mode]')) button.setAttribute('aria-pressed', String(button.dataset.historyMode === (frame.paused ? 'pause' : 'live')));
}
export function bindHistory(root: ParentNode, state: ReturnType<typeof createRateHistory>, snapshot: () => SdkRateSnapshot, changed: () => void) {
  const chart = root.querySelector<HTMLElement>('[data-history-chart]');
  if (!chart) return;
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
.history-period,.history-axis,.history-legend { display:flex; justify-content:space-between; gap:var(--space-2); font-size:11px; }
.history-period { flex-wrap:wrap; }
.history-summary-heading { display:grid; grid-template-columns:4px minmax(0,1fr) 4px; column-gap:var(--space-2); font-size:11px; }
.history-summary-heading > div { grid-column:2; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--space-2); min-height:36px; }
.history-period-time { display:flex; flex:1; align-items:baseline; justify-content:flex-end; gap:12px; color:var(--pyric-muted); font-variant-numeric:tabular-nums; white-space:nowrap; }
.history-duration { min-width:3ch; text-align:right; }
.history-period span,.history-axis,.history-help { color:var(--pyric-muted); }
.history-chart { position:relative; height:64px; touch-action:none; cursor:crosshair; border-bottom:1px solid var(--pyric-border); }
.history-chart:focus-visible { outline:2px solid var(--pyric-accent); outline-offset:2px; }
.history-chart svg { display:block; width:100%; height:100%; pointer-events:none; }
.history-chart polyline { fill:none; stroke:currentColor; stroke-width:2; vector-effect:non-scaling-stroke; }
.history-reads { color:var(--pyric-accent); }
.history-writes { color:var(--pyric-text); stroke-dasharray:5 3; }
.history-deliveries,.history-deletes { color:var(--pyric-muted); stroke-dasharray:2 3; }
.history-selection { fill:var(--pyric-accent); opacity:0.12; }
.history-scale { position:absolute; right:0; top:0; color:var(--pyric-muted); font-size:10px; }
.history-help { margin:0; font-size:11px; line-height:1.5; }
.history-legend span { display:inline-flex; align-items:center; gap:4px; }
.history-legend span::before { content:""; display:inline-block; width:12px; border-top:2px solid currentColor; }
.history-legend .history-writes::before { border-top-style:dashed; }
.history-legend .history-deliveries::before { border-top-style:dotted; }
`;
