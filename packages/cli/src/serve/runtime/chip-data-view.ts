/**
 * The chip's Data view: the sources the page read or listens to, each
 * source's history, and the controls that paint listeners on the page.
 *
 * The chip hands this module a small host (render, reveal the tab, open
 * Traffic, the index helpers Traffic shares) and asks it for the view's
 * markup and for its event bindings after each render. Everything about
 * listeners, sources, history, Overview, and Flow lives here, so a chip
 * change elsewhere does not touch it.
 */
import type { ServiceIndexQuery } from 'pyric/sandbox/internal';
import { aiModelHtml } from './ai-model-label.js';
import { activityOccurrences } from './activity-occurrences.js';
import { presentActivityOccurrence } from './activity-occurrence-presentation.js';
import { activityDisplayTarget, type ActivityHistoryEntry } from './activity-history.js';
import type { ListenerMode } from './listener-mode.js';
import type { ListenerOutline } from './listener-outline-model.js';
import { listenerColors } from './listener-palette.js';
import { pagePaintModeStorage, readListenerPaintMode, type ListenerPaintMode } from './listener-paint-mode.js';
import { serviceLabel, sourceLabel } from './service-presentation.js';
import {
  barHtml,
  buttonHtml,
  buttonRowHtml,
  clockTime,
  emptyHtml,
  escapeAttribute,
  iconHtml,
  pluralize,
  sectionHtml,
  type ChipView,
} from './chip-markup.js';

/** What the Data view needs from the chip that shows it. */
export interface ChipDataViewHost {
  document: Document;
  /** Build the Listeners mode; absent when the page has no event source. */
  build?: (onChange: (outlines: readonly ListenerOutline[]) => void) => ListenerMode;
  /** Rebuild the panel. */
  render(): void;
  /** `true` while the panel is open on the Data tab. */
  showing(): boolean;
  /** Open the panel on the Data tab, for a listener inspected from the page. */
  reveal(): void;
  /** Open Traffic, filtered to this source when there is one. */
  showTraffic(source: { service: string; target: string } | null): void;
  /** `true` when local index configuration lacks this query's index. */
  missingIndex(query: ServiceIndexQuery | undefined): boolean;
  /** The index details block Traffic also shows. */
  indexBlock(query: ServiceIndexQuery | undefined, key: string, sourceId?: string): string;
  /** The index action for the footer, or an empty string. */
  indexAction(query: ServiceIndexQuery | undefined, key: string): string;
}

export interface ChipDataView {
  /** The Listeners mode, built on first use. `null` without an event source. */
  mode(): ListenerMode | null;
  /** The listener outlines the view last rendered from. */
  outlines(): readonly ListenerOutline[];
  /** The view's markup. */
  view(): ChipView;
  /** Wire the rendered view's controls. */
  bind(root: ShadowRoot): void;
  /** The chip left the Data tab: drop the history selection and its highlight. */
  leave(): void;
  dispose(): void;
}

/** `true` when two listener lists would render the same Listeners view. */
function sameOutlines(a: readonly ListenerOutline[], b: readonly ListenerOutline[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((outline, i) => {
    const other = b[i];
    return outline.listenerId === other.listenerId
      && outline.label === other.label
      && outline.labelIsOwner === other.labelIsOwner
      && outline.target === other.target
      && outline.isQuery === other.isQuery
      && outline.deliveryCount === other.deliveryCount
      && outline.activity?.method === other.activity?.method
      && outline.activity?.status === other.activity?.status
      && outline.observedRender === other.observedRender
      && outline.selectors.join('\n') === other.selectors.join('\n')
      && outline.incident?.pattern === other.incident?.pattern
      && outline.incident?.count === other.incident?.count
      && outline.incident?.windowMs === other.incident?.windowMs;
  });
}

export function createChipDataView(host: ChipDataViewHost): ChipDataView {
  let listenerMode: ListenerMode | null = null;
  let listenerOutlines: readonly ListenerOutline[] = [];
  /** The remembered painting mode, for the control the chip draws before the
   * Listeners mode is built. */
  const paintModeBeforeBuild = readListenerPaintMode(pagePaintModeStorage(host.document));
  /** Why the outlines refused to come on, for the control's own title. */
  let outlinesRefused: string | null = null;
  /** Whether the last rendered panel carried the Flow waiting fact. */
  let renderedFlowWaiting = false;
  let renderedHistoryState = '';
  let inspectedFromPage = 0;
  let renderedTreatmentState = '';
  const ensureListenerMode = (): ListenerMode | null => {
    if (listenerMode !== null) return listenerMode;
    const build = host.build;
    if (build === undefined) return null;
    listenerMode = build((outlines) => {
      // The mode reports on every attach, delivery, and resize; rebuild the
      // view only when what the panel shows actually changes. The first
      // painted flow changes the panel without changing the outlines, because
      // it is what takes the waiting fact away.
      const waiting = listenerMode?.flowWaiting() === true;
      const treatmentState = JSON.stringify(listenerMode?.treatmentState?.());
      const historyState = JSON.stringify([listenerMode?.history?.snapshot(), listenerMode?.history?.counts({ scope: { kind: 'retained' } })]);
      const inspected = listenerMode?.selectedActivity?.() ?? null;
      const inspectionVersion = listenerMode?.inspectionVersion?.() ?? 0;
      const inspectionChanged = inspectionVersion !== inspectedFromPage;
      if (inspectionChanged) {
        inspectedFromPage = inspectionVersion;
        if (inspected) { selectedSourceKey = undefined; activeListenerId = inspected; selectedHistory = null; historyPage = 0;  host.reveal(); }
      }
      if (historyState === renderedHistoryState && !inspectionChanged && sameOutlines(outlines, listenerOutlines) && waiting === renderedFlowWaiting && treatmentState === renderedTreatmentState) return;
      renderedHistoryState = historyState;
      renderedTreatmentState = treatmentState;
      renderedFlowWaiting = waiting;
      listenerOutlines = outlines;
      if (host.showing()) host.render();
    });
    return listenerMode;
  };

  /** The listener a row click singled out on the page, if any. */
  let selectedSourceKey: string | undefined;
  let highlightedSourceKey: string | undefined;
  const queryForSource = (id: string): ServiceIndexQuery | undefined =>
    listenerOutlines.find(outline => outline.activity?.sourceId === id)?.activity?.indexQuery
    ?? listenerMode?.history?.snapshot().entries.find(entry => entry.sourceId === id && entry.indexQuery)?.indexQuery;
  let activeListenerId: string | null = null;
  let selectedHistory: number | null = null;
  let historyPage = 0;

  const selectedSourceId = (): string | undefined => {
    if (selectedSourceKey) return selectedSourceKey;
    const live = listenerOutlines.find(outline => outline.listenerId === activeListenerId);
    if (live) return live.activity?.sourceId ?? live.listenerId;
    return listenerMode?.history?.snapshot().entries.find(entry => entry.activityId === activeListenerId)?.sourceId;
  };
  const sourceGroups = () => {
    const groups = new Map<string, { id: string; activityId: string; target: string; service: string; members: ListenerOutline[] }>();
    for (const entry of listenerMode?.history?.snapshot().entries ?? []) {
      if (!groups.has(entry.sourceId)) groups.set(entry.sourceId, { id: entry.sourceId, activityId: entry.activityId, target: entry.target, service: entry.service, members: [] });
    }
    for (const outline of listenerOutlines) {
      const id = outline.activity?.sourceId ?? outline.listenerId;
      const group = groups.get(id) ?? { id, activityId: outline.listenerId, target: activityDisplayTarget(outline.target), service: outline.service, members: [] };
      group.members.push(outline);
      groups.set(id, group);
    }
    return [...groups.values()];
  };
  const activityDetailHtml = (id: string, event?: ActivityHistoryEntry): string => {
    const history = listenerMode?.history;
    const entries = history?.snapshot().entries.filter(entry => entry.activityId === id) ?? [];
    const start = entries.find(entry => entry.phase === 'start');
    const end = entries.find(entry => entry.phase === 'end');
    const association = event ? history?.association(event.sequence) : undefined;
    const candidates = history?.snapshot().entries.filter(entry => entry.phase === 'render' && association && entry.commitId === association.commitId && entry.activityId !== id) ?? [];
    const targets = [...new Set(candidates.map(entry => entry.target))];
    const facts: string[] = [];
    if (start?.kind === 'operation' && end) facts.push(`<div class="activity-fact"><span>Response time</span><span class="mono">${Math.max(0, end.at - start.at)} ms</span></div>`);
    if (targets.length) facts.push(`<span>Also observed in this render</span>${targets.map(target => `<span class="mono activity-path">${escapeAttribute(target)}</span>`).join('')}`);
    if (!facts.length) return '';
    return `<div class="activity-detail" data-activity-detail="${escapeAttribute(id)}"><div class="activity-detail-content">${facts.join('')}</div></div>`;
  };
  const historyHtml = (): string => {
    const history = listenerMode?.history;
    if (!history) return '';
    const snapshot = history.snapshot();
    const sourceId = selectedSourceId();
    const entries = activityOccurrences(snapshot.entries.filter(entry => entry.sourceId === sourceId));
    historyPage = Math.min(historyPage, Math.max(0, Math.ceil(entries.length / 10) - 1));
    const shown = entries.slice(historyPage * 10, historyPage * 10 + 10).map(occurrence => ({ ...occurrence, ...presentActivityOccurrence(occurrence) }));
    const counts = history.counts({ sourceId, scope: { kind: 'retained' } });
    const rows = shown.map(({ event: entry, label, outcome, registration }) => buttonRowHtml({
      c1: escapeAttribute(label),
      s1: escapeAttribute(registration === null ? entry.method : `${entry.method} #${registration}`),
      slot: `<span class="listener-fact"><span class="mono">${escapeAttribute(clockTime(entry.at))}</span><span>${outcome}</span></span>`,
      className: 'history-row', attributes: `data-history-entry="${entry.sequence}"`,
      label: `Inspect ${label}: ${outcome}${registration === null ? '' : `, Subscription ${registration}`}`, pressed: selectedHistory === entry.sequence, expanded: selectedHistory === entry.sequence && activityDetailHtml(entry.activityId, entry) !== '',
    }) + (selectedHistory === entry.sequence ? activityDetailHtml(entry.activityId, entry) : '')).join('');
    const inset = (html: string) => `<div class="history-context">${html}</div>`;
    return `<div class="history-body">
      ${inset(`<div class="history-summary"><span>${counts.partial ? '≥ ' : ''}${counts.calls} calls <span aria-hidden="true">/</span> ${counts.partial ? '≥ ' : ''}${counts.deliveries} results <span aria-hidden="true">/</span> ${counts.partial ? '≥ ' : ''}${counts.commits} renders</span>${buttonHtml('data-clear-activity-history', 'Clear', 'Clear all recorded history')}</div>`)}
      <div class="rows" data-activity-history>${rows}</div>
      ${!entries.length ? inset('<span class="hint">No events recorded since this view started or was cleared.</span>') : ''}
      ${entries.length > 10 ? inset(`<div class="history-pagination">${buttonHtml(`data-history-page="${historyPage - 1}"${historyPage === 0 ? ' disabled' : ''}`, 'Previous')}<span class="hint">${historyPage * 10 + 1}–${Math.min(entries.length, historyPage * 10 + 10)} of ${entries.length} items</span>${buttonHtml(`data-history-page="${historyPage + 1}"${(historyPage + 1) * 10 >= entries.length ? ' disabled' : ''}`, 'Next')}</div>`) : ''}
      ${inset(`<span class="hint">${snapshot.discarded ? `${snapshot.discarded} older events removed. Counts cover retained history.` : 'Counts cover recorded history.'} Clear or reload to reset.</span>`)}
    </div>`;

  };

  const dataPathHtml = (path: string): string => {
    const split = path.lastIndexOf('/') + 1;
    return `<span class="data-path" title="${escapeAttribute(path)}"><span class="data-path-parent">${escapeAttribute(path.slice(0, split))}</span><span class="data-path-leaf">${escapeAttribute(path.slice(split))}</span></span>`;
  };
  const listenersViewHtml = (): ChipView => {
    const outlinesOn = listenerMode?.enabled() === true;
    const paintMode: ListenerPaintMode = listenerMode?.mode() ?? paintModeBeforeBuild;
    const flowReason = listenerMode === null ? null : listenerMode.flowUnavailableReason();
    const pressed = (candidate: ListenerPaintMode): boolean => outlinesOn && paintMode === candidate;

    const groups = sourceGroups();
    const selected = groups.find(group => group.id === selectedSourceId());
    const rows = groups.map(group => {
      const modelActivity = group.members.find(member => member.activity?.ai)?.activity;
      const modelIdentity = modelActivity?.ai;
      const counts = group.members.some(member => !member.activity) ? undefined : listenerMode?.history?.counts({ sourceId: group.id, scope: { kind: 'retained' } });
      const stopped = group.members.some(member => member.activity?.kind === 'subscription') && group.members.every(member => member.activity && (member.activity.kind !== 'subscription' || member.activity.status === 'closed'));
      const calls = counts?.calls ?? group.members.length;
      const deliveries = counts?.deliveries ?? group.members.reduce((sum, member) => sum + member.deliveryCount, 0);
      const indexMissing = host.missingIndex(queryForSource(group.id));
      // A source is placed when any of its calls has an element on the page.
      const reasons = group.members.map(member => listenerMode?.placementReason(member) ?? null);
      const unplaced = group.members.length > 0 && reasons.every(reason => reason !== null) ? reasons[0] : null;
      const facts = [
        indexMissing ? '<span class="index-status">Index missing from config</span>' : '',
        unplaced ? `<span class="unplaced-reason" data-listener-unplaced>${escapeAttribute(unplaced)}</span>` : '',
      ].filter(Boolean);
      const highlightTitle = unplaced ?? `Highlight ${group.target}`;
      return '<div class="source-row">' + buttonRowHtml({
        c1: modelIdentity ? aiModelHtml(modelIdentity, escapeAttribute, modelActivity?.method) : dataPathHtml(group.target),
        s2: facts.join(''),
        s1: `${sourceLabel(group.service, group.target, group.members.some(member => member.isQuery))}${stopped ? ' — Stopped' : ''}${group.members.some(member => member.incident) ? ' — Duplicate subscriptions' : ''}`,
        slot: `<span class="listener-fact"><span>${counts?.partial ? '≥ ' : ''}${pluralize(calls, 'call')}</span><span>${counts?.partial ? '≥ ' : ''}${pluralize(deliveries, 'delivery', 'deliveries')}</span></span>`,
        leading: `<span class="listener-mark" style="--listener-color:${escapeAttribute(listenerColors(group.id).swatch)}"></span>`,
        className: group.members.some(member => member.incident) ? 'listener-row problem' : indexMissing ? 'listener-row pending' : 'listener-row', title: `Inspect ${group.target}`,
        attributes: `${group.members.some(member => member.incident) ? 'data-listener-incident="true" ' : ''}data-listener-row="${escapeAttribute(group.activityId)}" data-activate-listener="${escapeAttribute(group.activityId)}"`,
        label: `Inspect ${group.target}`, expanded: false,
      }) + `<button type="button" class="source-highlight" data-highlight-source="${escapeAttribute(group.id)}" aria-label="Highlight ${escapeAttribute(group.target)}" title="${escapeAttribute(highlightTitle)}" aria-pressed="${outlinesOn && highlightedSourceKey === group.id}"${unplaced ? ' disabled' : ''}>${iconHtml('eye')}</button></div>`;
    });
    const blocked = outlinesRefused;
    const allOn = outlinesOn && paintMode === 'overview' && highlightedSourceKey === undefined && listenerOutlines.every((outline) => listenerMode?.isListenerVisible(outline.listenerId));
    const toggle = `<button type="button" class="listener-toggle" data-listener-all aria-pressed="${allOn}"><span class="toggle-track" aria-hidden="true"></span>Show all</button>`;
    const treatment = listenerMode?.treatmentState?.();
    const description = treatment?.choices.find(entry => entry.id === treatment.selected)?.description ?? '';
    const picker = treatment ? `<select id="pyric-flow-treatment" data-flow-treatment aria-label="Flow treatment" title="${escapeAttribute(description)}">${['Standard', 'Experimental', 'Custom'].map(group => { const entries = treatment.choices.filter(entry => entry.group === group); return entries.length ? `<optgroup label="${group}">${entries.map(entry => `<option value="${escapeAttribute(entry.id)}" title="${escapeAttribute(entry.description)}"${entry.id === treatment.selected ? ' selected' : ''}>${escapeAttribute(entry.name)}</option>`).join('')}</optgroup>` : ''; }).join('')}</select>` : '<span></span>';
    const notice = treatment?.error ? `<span class="hint" role="alert">${escapeAttribute(treatment.error)}</span>${buttonHtml(`data-treatment-retry="${escapeAttribute(treatment.retry ?? treatment.selected)}"`, 'Retry')}` : treatment?.loading ? '<span class="hint" role="status">Loading treatment…</span>' : '';
    const toolbar = `<div class="listener-toolbar"><div class="paint-switch" role="group" aria-label="Highlight mode">${buttonHtml(`data-listener-mode="overview" aria-pressed="${pressed('overview')}"`, 'Overview')}${buttonHtml(`data-listener-mode="flow" aria-pressed="${pressed('flow')}"${flowReason === null ? '' : ' disabled'}`, 'Flow', flowReason ?? 'Show what rendered after each delivery')}</div>${picker}<button type="button" class="btn icon-button" data-open-overlay-theme aria-label="Highlight settings" title="Highlight settings">${iconHtml('settings')}</button>${notice ? `<span class="listener-toolbar-notice">${notice}</span>` : ''}</div>`;
    let bar = barHtml([toolbar]);
    const overviewReason = listenerMode?.overviewUnavailableReason();
    const regionGuidance = [overviewReason, flowReason].filter(Boolean).join(' ');
    const guidance = blocked ?? regionGuidance;
    const list = `<div class="rows" data-listener-rows>${rows.join('')}</div>${rows.length ? '' : emptyHtml('No reads or listeners yet', 'Read or subscribe to data in your app to see activity here. Select a row to highlight its associated components.')}`;
    let body = sectionHtml(pluralize(groups.length, 'source'), list, listenerMode?.history?.counts({ scope: { kind: 'retained' } }).partial ? 'Retained history / incomplete' : '', toggle);
    if (selected) {
      body = `<div class="history-context"><div class="source-navigation"><nav class="data-breadcrumbs" aria-label="Breadcrumb"><button type="button" data-sources-back>Data</button>${iconHtml('chevron')}<span class="breadcrumb-service">${serviceLabel(selected.service)}</span>${iconHtml('chevron')}<span class="breadcrumb-target" aria-current="page" title="${escapeAttribute(selected.target)}">${selected.service === 'ai' ? 'Model requests' : escapeAttribute(selected.target)}</span></nav><a href="#pyric-traffic" class="nav-link" data-source-traffic aria-label="View traffic" title="View matching traffic">Traffic${iconHtml('chevron')}</a></div></div>` + historyHtml();
    }
    if (selected) body += `<div class="history-context">${host.indexBlock(queryForSource(selected.id), selected.id, selected.id)}</div>`;
    if (selected) {
      const action = host.indexAction(queryForSource(selected.id), selected.id);
      if (action) bar = barHtml([`<div class="index-toolbar">${toolbar}<div class="index-submit">${action}</div></div>`]);
    }
    if (guidance) body += `<span class="hint" data-flow-unavailable>${escapeAttribute(guidance)}</span>`;
    return { body, bar };

  };

  return {
    mode: ensureListenerMode,
    outlines: () => listenerOutlines,
    view() {
      renderedFlowWaiting = listenerMode?.flowWaiting() === true;
      return listenersViewHtml();
    },
    bind(root) {
      root.querySelector<HTMLSelectElement>('[data-flow-treatment]')?.addEventListener('change', (event) => {
        const select = event.currentTarget as HTMLSelectElement;
        void listenerMode?.setTreatment?.(select.value);
      });
      root.querySelector('[data-treatment-retry]')?.addEventListener('click', () => {
        const retry = listenerMode?.treatmentState?.().retry;
        if (retry) void listenerMode?.setTreatment?.(retry);
      });
      root.querySelector('[data-listener-all]')?.addEventListener('click', () => {
        const mode = ensureListenerMode();
        if (!mode) return;
        const allOn = mode.enabled() && mode.mode() === 'overview' && highlightedSourceKey === undefined && mode.outlines().every((outline) => mode.isListenerVisible(outline.listenerId));
        activeListenerId = null; selectedSourceKey = undefined; highlightedSourceKey = undefined;
        for (const outline of mode.outlines()) mode.setListenerVisible(outline.listenerId, true);
        if (!allOn) mode.setMode('overview');
        mode.setEnabled(!allOn);
        outlinesRefused = !allOn && !mode.enabled() ? 'Listener attribution is off in this build, so there are no owners to outline.' : null;
        listenerOutlines = mode.outlines();
        host.render();
      });
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-listener-mode]')) {
        button.addEventListener('click', () => {
          const mode = ensureListenerMode();
          if (mode === null) return;
          const paint: ListenerPaintMode = button.dataset.listenerMode === 'flow' ? 'flow' : 'overview';
          // A pressed mode pressed again is the outlines going off; anything
          // else is that mode going on.
          if (mode.enabled() && mode.mode() === paint) {
            mode.setEnabled(false);
            activeListenerId = null; selectedSourceKey = undefined; highlightedSourceKey = undefined;
            for (const outline of mode.outlines()) mode.setListenerVisible(outline.listenerId, true);
            outlinesRefused = null;
          } else {
            mode.setMode(paint);
            mode.setEnabled(true);
            outlinesRefused = mode.enabled()
              ? mode.mode() === paint ? null : mode.flowUnavailableReason()
              : 'Listener attribution is off in this build, so there are no owners to outline.';
          }
          listenerOutlines = mode.outlines();
          host.render();
        });
      }
      // A listener row singles its listener out on the page: the outlines come
      // on if they were off, and only that listener is painted until the row is
      // pressed again.
      root.querySelector('[data-source-traffic]')?.addEventListener('click', (event) => {
        event.preventDefault();
        const selected = sourceGroups().find(group => group.id === selectedSourceId());
        host.showTraffic(selected ? { service: selected.service, target: selected.target } : null);
      });
      root.querySelector('[data-sources-back]')?.addEventListener('click', () => {
        activeListenerId = null; selectedSourceKey = undefined; selectedHistory = null; historyPage = 0;
        listenerMode?.inspectHistory?.(null);
        host.render();
        const view = root.querySelector<HTMLElement>('.view'); if (view) view.scrollTop = 0;
        root.querySelector<HTMLButtonElement>('[data-listener-row]')?.focus();
      });
      root.querySelector('[data-clear-activity-history]')?.addEventListener('click', () => {
        selectedHistory = null; historyPage = 0;
        listenerMode?.clearActivityHistory?.(); host.render();
      });
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-history-page]')) {
        button.addEventListener('click', () => { historyPage = Number(button.dataset.historyPage); host.render(); });
      }
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-history-entry]')) {
        button.addEventListener('click', () => {
          const sequence = Number(button.dataset.historyEntry);
          selectedHistory = selectedHistory === sequence ? null : sequence;
          const entry = listenerMode?.history?.snapshot().entries.find(entry => entry.sequence === sequence);
          const associated = listenerMode?.history?.association(sequence);
          const highlightSequence = selectedHistory === null ? null : associated?.sequence ?? null;
          listenerMode?.inspectHistory?.(highlightSequence);

          host.render();
        });
      }
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-highlight-source]')) {
        button.addEventListener('click', () => {
          const mode = ensureListenerMode();
          if (!mode) return;
          const sourceId = button.dataset.highlightSource;
          const turnOff = mode.enabled() && highlightedSourceKey === sourceId;
          highlightedSourceKey = turnOff ? undefined : sourceId;
          mode.inspectHistory?.(null);
          for (const outline of mode.outlines()) {
            mode.setListenerVisible(outline.listenerId, turnOff || (outline.activity?.sourceId ?? outline.listenerId) === sourceId);
          }
          mode.setMode('overview');
          mode.setEnabled(!turnOff);
          host.render();
          root.querySelectorAll<HTMLButtonElement>('[data-highlight-source]').forEach(next => {
            if (next.dataset.highlightSource === sourceId) next.focus({ preventScroll: true });
          });
        });
      }
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-activate-listener]')) {
        button.addEventListener('click', () => {
          const mode = ensureListenerMode();
          const listenerId = button.dataset.activateListener;
          if (mode === null || listenerId === undefined) return;
          historyPage = 0; selectedHistory = null;
          selectedSourceKey = sourceGroups().find(group => group.activityId === listenerId)?.id;
          activeListenerId = listenerId;
          listenerOutlines = mode.outlines();
          host.render();
          const view = root.querySelector<HTMLElement>('.view'); if (view) view.scrollTop = 0;
          root.querySelector<HTMLButtonElement>('[data-sources-back]')?.focus();
        });
      }
    },
    leave() {
      listenerMode?.inspectHistory?.(null);
      selectedHistory = null;
    },
    dispose() {
      listenerMode?.dispose();
    },
  };
}
