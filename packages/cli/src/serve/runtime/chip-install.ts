import {
  mountPyricRuntimeChip,
  type PyricRuntimeChip,
  type PyricRuntimeChipOptions,
} from './chip.js';
import { readPyricRuntimeChipConfig } from './chip-config.js';
import type { PyricRuntimeStatus } from './status.js';
import type { RuntimeIdentityBindings } from './identity.js';
import { listenerAttributionEnabled } from 'pyric/sandbox/internal';
import { createListenerMode } from './listener-mode.js';
import type { SandboxEventSource } from './listener-event-source.js';
import { installReactCommitSource, type ReactCommitSource } from './react-commit-source.js';
import { createListenerObservation, pageListenerObservation, type ListenerObservation } from './listener-observation.js';
import type { OverlayTheme } from './overlay-theme.js';

export interface InstallPyricRuntimeChipOptions {
  runtime: PyricRuntimeStatus;
  document: Document;
  identity?: Partial<RuntimeIdentityBindings>;
  /** The page's sandbox event source. Omitted leaves the Listeners mode out. */
  listenerEvents?: SandboxEventSource | null;
  /**
   * React's commits, for the Listeners mode's Flow painting. Install this from
   * the page's own init script, before the application's script runs: React
   * reads the hook global once, while its own module first evaluates, so a
   * source installed later never sees a commit. Omitted, the chip installs one
   * here, which is in time only when the chip itself mounts that early.
   */
  commits?: ReactCommitSource;
  /**
   * Custom property overrides for the painted listener overlay, for a served
   * page that wants its own look. The page's own stored overrides win over
   * these, and both win over the contract's defaults. See `overlay-theme.ts`.
   */
  overlayTheme?: OverlayTheme;
  mount?: (options: PyricRuntimeChipOptions) => PyricRuntimeChip;
}

/** Mount once when the Vite plugin opted this page into runtime UI. */
export function installPyricRuntimeChip(
  options: InstallPyricRuntimeChipOptions,
): PyricRuntimeChip | null {
  const config = readPyricRuntimeChipConfig(options.document);
  const existing = options.document.querySelector('[data-pyric-runtime-chip-host], pyric-runtime-chip');
  const skipsMount = config === null || existing !== null;
  if (skipsMount) return null;
  const chipOptions: PyricRuntimeChipOptions = {
    runtime: options.runtime,
    document: options.document,
    initiallyOpen: config.initiallyOpen,
    identity: options.identity,
  };
  const studioEnabled = config.studioEnabled;
  const hidesStudio = !studioEnabled;
  if (hidesStudio) chipOptions.studioUrl = null;
  let observation: ListenerObservation | null = null;
  const events = options.listenerEvents;
  const hasEvents = events !== null && events !== undefined;
  if (hasEvents) {
    // Traffic folds the same stream the Listeners mode does, from its own
    // subscription, so neither fold has to know the other exists.
    chipOptions.sandboxEvents = events;
    const studioUrl = studioEnabled
      ? options.runtime.getSnapshot().manifest.studioUrl
      : null;
    // SDK initialization normally starts observation first. Direct chip users
    // start it here, before mounting or constructing the listener mode.
    const injectedCommits = options.commits;
    const hasInjectedCommits = injectedCommits !== undefined;
    if (hasInjectedCommits) observation = createListenerObservation(options.document, injectedCommits);
    else observation = pageListenerObservation(options.document);
    const commits = observation?.commits ?? installReactCommitSource(options.document.defaultView);
    chipOptions.listeners = (onChange) => createListenerMode({
      document: options.document,
      subscribeEvents: events,
      attributionEnabled: listenerAttributionEnabled,
      studioUrl,
      commits,
      observation: observation ?? undefined,
      overlayTheme: options.overlayTheme ?? null,
      onChange,
    });
  }
  const mount = options.mount ?? mountPyricRuntimeChip;
  const chip = mount(chipOptions);
  const dispose = chip.dispose.bind(chip);
  chip.dispose = () => { dispose(); observation?.dispose(); };
  return chip;
}
