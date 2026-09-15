import type { SandboxEvent } from 'pyric/sandbox';
import type { ChipRequest } from './chip-traffic.js';
import { createListenerOverlay } from './listener-overlay.js';
import { outlineSelectors, type ListenerOutline } from './listener-outline-model.js';

/** Denials decorate known owners or explicitly related regions, never inferred renders. */
export function createDenialMarkers(options: {
  document: Document;
  related: (service: string, path: string) => { sourceId: string; elements: Element[] } | null;
  select: (request: ChipRequest) => void;
}) {
  const records = new Map<string, { request: ChipRequest; elements: Element[]; outline: ListenerOutline; timer: ReturnType<typeof setTimeout> }>();
  let overlay: ReturnType<typeof createListenerOverlay> | null = null;
  const redraw = () => {
    if (!records.size) { overlay?.dispose(); overlay = null; return; }
    if (!overlay) {
      overlay = createListenerOverlay({
        document: options.document,
        observedElements: outline => records.get(outline.listenerId)?.elements ?? [],
        badgeLabel: outline => outline.label,
        onSelect: outline => {
          const record = records.get(outline.listenerId);
          if (record) options.select(record.request);
        },
      });
      overlay.container().setAttribute('data-pyric-denials', '');
      const style = options.document.createElement('style');
      style.textContent = '[data-pyric-denials] [data-pyric-listener-box] { background: transparent; border-style: dashed; } [data-pyric-denials] [data-pyric-listener-badge] { border-color: #ff9292; color: #ffb4b4; }';
      overlay.container().append(style);
    }
    overlay.update([...records.values()].map(record => record.outline));
  };
  const remove = (id: string) => {
    const record = records.get(id);
    if (record) clearTimeout(record.timer);
    records.delete(id); redraw();
  };
  return {
    show(request: ChipRequest, event: SandboxEvent) {
      if (request.verdict !== 'denied' || !request.service || !request.path || records.has(request.id)) return;
      const selectors = outlineSelectors('owners' in event && Array.isArray(event.owners) ? event.owners : []);
      const owners = selectors.flatMap(selector => {
        try { return [...options.document.querySelectorAll(selector)]; } catch { return []; }
      });
      const related = options.related(request.service, request.path);
      const elements = [...new Set(owners.length ? owners : related?.elements ?? [])].filter(el => el.isConnected).slice(0, 20);
      if (!elements.length) return;
      const verb = ['get', 'list', 'listen'].includes(request.method ?? '') ? 'Read' : 'Write';
      const label = `⚠ ${verb} denied${owners.length ? '' : ' — related region'}: ${request.path}`;
      const outline: ListenerOutline = {
        listenerId: request.id, colorKey: related?.sourceId ?? `${request.service}:${request.path}`, label, labelIsOwner: false, target: request.path,
        service: request.service === 'database' ? 'database' : 'firestore',
        isQuery: false, deliveryCount: 0, selectors: [], incident: null,
      };
      records.set(request.id, { request: { ...request }, elements, outline, timer: setTimeout(() => remove(request.id), 8000) });
      if (records.size > 5) remove(records.keys().next().value!);
      redraw();

    },
    dispose() {
      for (const record of records.values()) clearTimeout(record.timer);
      records.clear(); overlay?.dispose(); overlay = null;
    },
  };
}
