import { sdkActivity } from 'pyric/sandbox/internal';
import { activityOutlines } from './listener-outline-model.js';
import { createFlowMode, type FlowMode, type FlowModeOptions } from './listener-flow-mode.js';
import type { FlowPaint } from './listener-flow-painter.js';
import type { FlowComponent } from './fiber-flow.js';
import { installReactCommitSource, type ReactCommitSource } from './react-commit-source.js';
import { readPyricRuntimeChipConfig } from './chip-config.js';

export type ListenerObservationBindings = Pick<FlowModeOptions,
  'outlineFor' | 'isVisible' | 'onObserved' | 'onTreatmentPaint' | 'recentDeliveries' | 'onPaint'>;

export interface ListenerObservation {
  readonly commits: ReactCommitSource;
  readonly flow: FlowMode;
  /** Adopt startup evidence after the mode has populated its activity outlines. */
  attach(bindings: ListenerObservationBindings): void;
  dispose(): void;
}

interface RetainedComponent {
  node: Omit<FlowComponent, 'element'>;
  element: WeakRef<Element>;
  isRoot: boolean;
  isLeaf: boolean;
}
interface StartupRender {
  paint: Omit<FlowPaint, 'subtree'>;
  components: RetainedComponent[];
  commitId: number;
}

const MAX_STARTUP_RENDERS = 100;
const MAX_STARTUP_COMPONENTS = 100;

/** Observe immediately, retaining bounded weak evidence until the chip adopts it. */
export function createListenerObservation(document: Document, commits: ReactCommitSource): ListenerObservation {
  let bindings: ListenerObservationBindings | null = null;
  let disposed = false;
  const startup: StartupRender[] = [];
  const unobserved = new Set<string>();
  const flow = createFlowMode({
    document, commits,
    outlineFor(id) {
      const consumer = bindings;
      const hasConsumer = consumer !== null;
      if (hasConsumer) return consumer.outlineFor(id);
      const outlines = activityOutlines([], sdkActivity.records(), unobserved);
      return outlines.find(outline => outline.listenerId === id || outline.clientListenerId === id) ?? null;
    },
    isVisible: id => bindings?.isVisible(id) ?? false,
    recentDeliveries: () => bindings?.recentDeliveries?.() ?? [],
    onTreatmentPaint: paint => bindings?.onTreatmentPaint?.(paint),
    onPaint: id => bindings?.onPaint?.(id),
    onObserved(paint, commitId) {
      const consumer = bindings;
      const hasConsumer = consumer !== null;
      if (hasConsumer) {
        consumer.onObserved?.(paint, commitId);
        return;
      }
      const { subtree, ...metadata } = paint;
      startup.push({ paint: metadata, commitId,
        components: subtree.components.slice(0, MAX_STARTUP_COMPONENTS).map(component => {
          const { element, ...node } = component;
          return { node, element: new WeakRef(element),
            isRoot: component === subtree.root, isLeaf: subtree.leaves.includes(component),
          };
        }),
      });
      const exceedsCapacity = startup.length > MAX_STARTUP_RENDERS;
      if (exceedsCapacity) startup.shift();
    },
  });
  return {
    commits, flow,
    attach(consumer) {
      if (disposed) return;
      bindings = consumer;
      for (const render of startup.splice(0)) {
        const retained = render.components.flatMap(component => {
          const element = component.element.deref();
          const isDetached = element?.isConnected !== true;
          if (isDetached) return [];
          return [{ node: { ...component.node, element }, isRoot: component.isRoot, isLeaf: component.isLeaf }];
        });
        const hasNoAttachedComponents = retained.length === 0;
        if (hasNoAttachedComponents) continue;
        // Startup evidence feeds Overview/history only, never the live painter.
        consumer.onObserved?.({ ...render.paint, subtree: {
          root: retained.find(component => component.isRoot)?.node ?? null,
          components: retained.map(component => component.node),
          leaves: retained.filter(component => component.isLeaf).map(component => component.node),
        } }, render.commitId);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      bindings = null;
      startup.length = 0;
      flow.dispose();
    },
  };
}

const pageObservations = new WeakMap<Document, ListenerObservation>();

/** Called during SDK initialization, before async configuration or application code. */
export function pageListenerObservation(document: Document): ListenerObservation | null {
  const view = document.defaultView;
  const hasNoPage = view === null || view === undefined;
  if (hasNoPage) return null;
  const chipDisabled = readPyricRuntimeChipConfig(document) === null;
  if (chipDisabled) return null;
  const existing = pageObservations.get(document);
  const alreadyObserving = existing !== undefined;
  if (alreadyObserving) return existing;
  const commits = installReactCommitSource(view);
  const observation = createListenerObservation(document, commits);
  const dispose = observation.dispose;
  observation.dispose = () => {
    dispose();
    commits.dispose();
    pageObservations.delete(document);
  };
  pageObservations.set(document, observation);
  return observation;
}
