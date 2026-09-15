import { flowBadgeFor } from "../listener-flow-painter.js";
import { builtinTreatments } from "./catalog.js";
import { builtinLoaders } from "./builtins.js";
import type { FlowPaint } from "../listener-flow-painter.js";
import type {
  FlowTreatment,
  FlowTreatmentInstance,
  FlowTreatmentManifest,
  FlowTreatmentMetadata,
  FlowTreatmentRecord,
  FlowTreatmentState,
} from "./types.js";

export const FLOW_TREATMENT_KEY = "pyric:flow-treatment";
export interface TreatmentControllerOptions {
  document: Document;
  onChange(): void;
  /** Injected by standalone consumers; served pages discover the shared host. */
  manifest?: FlowTreatmentManifest;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  load?: (url: string) => Promise<{ default: FlowTreatment }>;
}

export function createTreatmentController(options: TreatmentControllerOptions) {
  const doc = options.document;
  let storage = options.storage;
  if (storage === undefined) {
    try {
      storage = doc.defaultView?.localStorage;
    } catch {
      storage = null;
    }
  }
  let selected = "outline",
    loading: string | null = null,
    error: string | null = null;
  let retry: string | null = null;
  let choices: FlowTreatmentMetadata[] = [...builtinTreatments];
  let manifest: FlowTreatmentManifest = { treatments: [] };
  let configured = false,
    initialization: Promise<void> | null = null;
  let container: HTMLElement | null = null,
    style: HTMLStyleElement | null = null;
  let implementation: FlowTreatment | null = null,
    instance: FlowTreatmentInstance | null = null;
  let serial = 0,
    sequence = 0,
    disposed = false;
  let records: FlowTreatmentRecord[] = [];
  let counts = new WeakMap<HTMLElement, number>();
  const cache = new Map<string, FlowTreatment>();
  const marked = new Set<HTMLElement>();
  const history = () =>
    records
      .map((record) => ({
        ...record,
        elements: record.elements.filter(
          (el) =>
            el.isConnected &&
            el.getAttribute("data-pyric-flow-listener") === record.listenerId,
        ),
      }))
      .filter((record) => record.elements.length);
  const state = (): FlowTreatmentState => ({
    selected,
    loading,
    error,
    retry,
    choices,
  });
  const notify = () => {
    if (!disposed) options.onChange();
  };
  const unmount = () => {
    instance?.dispose();
    instance = null;
    style?.remove();
    style = null;
    if (doc.documentElement.getAttribute("data-pyric-treatment") === selected)
      doc.documentElement.removeAttribute("data-pyric-treatment");
  };
  const mount = (value: FlowTreatment) => {
    if (!container) return;
    style = doc.createElement("style");
    style.setAttribute("data-pyric-treatment-style", "");
    style.textContent = value.css;
    container.append(style);
    doc.documentElement.setAttribute("data-pyric-treatment", selected);
    instance = value.mount?.({ document: doc, container, history }) ?? null;
    instance?.update();
  };
  const initialize = () =>
    (initialization ??= (async () => {
      if (options.manifest) manifest = options.manifest;
      else if (doc.defaultView?.fetch) {
        try {
          const response = await doc.defaultView.fetch(
            "/__pyric/flow/manifest.json",
          );
          if (response.ok)
            manifest = (await response.json()) as FlowTreatmentManifest;
        } catch {
          /* Hostless pages retain the packaged built-ins. */
        }
      }
      if (disposed) return;
      const ids = new Set(choices.map((entry) => entry.id));
      manifest.treatments = (manifest.treatments ?? []).filter((entry) => {
        if (
          !entry ||
          typeof entry.id !== "string" ||
          typeof entry.url !== "string" ||
          ids.has(entry.id)
        )
          return false;
        ids.add(entry.id);
        return true;
      });
      choices = [
        ...choices,
        ...manifest.treatments.map((entry) => ({
          ...entry,
          group: "Custom" as const,
        })),
      ];
      let stored: string | null = null;
      try {
        stored = storage?.getItem(FLOW_TREATMENT_KEY) ?? null;
      } catch {
        /* restricted storage */
      }
      selected = [stored, manifest.treatment, "outline"].find(
        (id) => id && ids.has(id),
      )!;
      configured = true;
    })());
  const select = async (id: string, persist = true): Promise<void> => {
    const request = ++serial;
    if (!configured) await initialize();
    if (disposed || request !== serial) return;
    if (!choices.some((entry) => entry.id === id)) {
      error = `Unknown treatment: ${id}`;
      notify();
      return;
    }
    loading = id;
    error = null;
    retry = null;
    notify();
    try {
      let value = cache.get(id);
      if (!value) {
        const builtin = builtinLoaders[id];
        const custom = manifest.treatments.find((entry) => entry.id === id);
        const loaded = builtin
          ? await builtin()
          : await (options.load ?? ((url) => import(/* @vite-ignore */ url)))(
              `${custom!.url}?attempt=${request}`,
            );
        value = loaded.default;
        if (
          !value ||
          typeof value.css !== "string" ||
          (value.mount !== undefined && typeof value.mount !== "function")
        )
          throw new Error(
            "Expected a default export with css and optional mount",
          );
        cache.set(id, value);
      }
      if (disposed || request !== serial) return;
      const previous = implementation,
        previousId = selected;
      unmount();
      selected = id;
      try {
        mount(value);
        implementation = value;
      } catch (cause) {
        unmount();
        selected = previousId;
        implementation = previous;
        if (previous) mount(previous);
        throw cause;
      }
      if (persist) {
        try {
          storage?.setItem(FLOW_TREATMENT_KEY, id);
        } catch {
          /* session-only selection */
        }
      }
    } catch (cause) {
      if (disposed || request !== serial) return;
      retry = id;
      error = `Could not load ${choices.find((entry) => entry.id === id)?.name ?? id}: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    if (request === serial) {
      loading = null;
      notify();
    }
  };
  const clear = () => {
    records = [];
    counts = new WeakMap();
    for (const el of marked) {
      for (const name of ["hits", "sequence", "name", "size"])
        el.removeAttribute(`data-pyric-flow-${name}`);
      el.style.removeProperty("--pyric-flow-heat");
    }
    marked.clear();
    instance?.update();
  };
  return {
    state,
    select,
    async attach(next: HTMLElement) {
      container = next;
      const request = serial;
      await initialize();
      // Configuration discovery must not replace an explicit choice made while
      // it was pending, or compete with a treatment already being loaded.
      if (disposed || container !== next || request !== serial || loading) return;
      await select(selected, false);
      if (!implementation && error && !disposed && container === next) {
        const failed = retry,
          message = error;
        await select("outline", false);
        retry = failed;
        error = message;
        notify();
      }
    },
    detach() {
      ++serial;
      loading = null;
      unmount();
      container = null;
      clear();
    },
    record(paint: FlowPaint) {
      const elements = paint.subtree.components
        .map((component) => component.element)
        .filter(
          (el): el is HTMLElement =>
            !!doc.defaultView && el instanceof doc.defaultView.HTMLElement,
        );
      if (!elements.length) return;
      ++sequence;
      for (const component of paint.subtree.components) {
        const el = component.element as HTMLElement;
        if (!elements.includes(el)) continue;
        const count = (counts.get(el) ?? 0) + 1;
        counts.set(el, count);
        marked.add(el);
        el.dataset.pyricFlowHits = String(count);
        el.dataset.pyricFlowSequence = String(sequence);
        el.dataset.pyricFlowName = component.name;
        el.style.setProperty(
          "--pyric-flow-heat",
          String(Math.max(32, 210 - count * 22)),
        );
        // Pseudo-element animations require subtree lookup. Restrict the
        // effect target so a parent paint cannot restart child animations.
        for (const animation of el.getAnimations?.({ subtree: true }) ?? []) {
          if (
            (animation.effect as KeyframeEffect | null)?.target === el &&
            "animationName" in animation &&
            String(animation.animationName).startsWith("pyric-treatment-")
          ) {
            animation.cancel();
            animation.play();
          }
        }
      }
      records.push({
        sequence,
        listenerId: paint.listenerId,
        label: paint.label,
        target: paint.target,
        elements,
      });
      records = records.slice(-5);
      this.reposition();
    },
    reposition() {
      for (const el of marked) {
        if (!el.isConnected || !el.hasAttribute("data-pyric-flow")) {
          for (const name of ["hits", "sequence", "name", "size"])
            el.removeAttribute(`data-pyric-flow-${name}`);
          el.style.removeProperty("--pyric-flow-heat");
          marked.delete(el);
          continue;
        }
        const rect = el.getBoundingClientRect();
        const size = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
        if (el.dataset.pyricFlowSize !== size) el.dataset.pyricFlowSize = size;
      }
      records = history();
      for (const el of marked) {
        const badge = flowBadgeFor(el);
        if (!badge) continue;
        for (const name of ["hits", "sequence", "name", "size"]) {
          const value = el.getAttribute(`data-pyric-flow-${name}`);
          if (
            value !== null &&
            badge.getAttribute(`data-pyric-flow-${name}`) !== value
          )
            badge.setAttribute(`data-pyric-flow-${name}`, value);
        }
      }
      instance?.update();
    },
    clear,
    dispose() {
      disposed = true;
      this.detach();
    },
  };
}
