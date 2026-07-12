export const STUDIO_EMBED_PARAM = 'embed';
export const STUDIO_EMBED_VALUE = 'studio';
export const PLAYGROUND_SANDBOX_PARAM = 'sandbox';
export const STUDIO_NAVIGATE_SETTINGS_MESSAGE = 'pyric:studio:navigate-settings';
export const PLAYGROUND_OPEN_KEYS_MESSAGE = 'pyric:playground:open-keys';
export const PLAYGROUND_OPEN_SETTINGS_MESSAGE = 'pyric:playground:open-settings';
export const PLAYGROUND_SET_MODEL_MESSAGE = 'pyric:playground:set-model';
/** playground → Studio: the current session breadcrumb, so Studio can render
 *  it in its own Prototype controls bar (the embed-hidden TopBar has no home
 *  for it, and the in-workspace StatusBar spot reads as misplaced). */
export const PLAYGROUND_BREADCRUMB_MESSAGE = 'pyric:playground:breadcrumb';

export type StudioSettingsSection = 'ai' | 'playground' | 'diagnostics';

export interface StudioNavigateSettingsMessage {
  type: typeof STUDIO_NAVIGATE_SETTINGS_MESSAGE;
  section?: StudioSettingsSection;
}

export type PlaygroundProviderId =
  | 'gemini'
  | 'openrouter'
  | 'ollama'
  | 'llamaServer';

export type PlaygroundReasoningEffort = 'off' | 'low' | 'medium' | 'high';
export type PlaygroundSandboxMode = 'shared' | 'isolated';

export type PlaygroundCommandMessage =
  | { type: typeof PLAYGROUND_OPEN_KEYS_MESSAGE }
  | { type: typeof PLAYGROUND_OPEN_SETTINGS_MESSAGE }
  | {
      type: typeof PLAYGROUND_SET_MODEL_MESSAGE;
      providerId: PlaygroundProviderId;
      modelId: string;
      effort?: PlaygroundReasoningEffort;
    };

export function isStudioEmbedSearch(search: string): boolean {
  return new URLSearchParams(search).get(STUDIO_EMBED_PARAM) === STUDIO_EMBED_VALUE;
}

export function readPlaygroundSandboxMode(search: string): PlaygroundSandboxMode {
  const params = new URLSearchParams(search);
  const raw = params.get(PLAYGROUND_SANDBOX_PARAM);
  if (raw === 'shared') return 'shared';
  if (raw === 'isolated') return 'isolated';
  return params.get(STUDIO_EMBED_PARAM) === STUDIO_EMBED_VALUE ? 'shared' : 'isolated';
}

export function isPlaygroundCommandMessage(value: unknown): value is PlaygroundCommandMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  if (
    type === PLAYGROUND_OPEN_KEYS_MESSAGE ||
    type === PLAYGROUND_OPEN_SETTINGS_MESSAGE
  ) {
    return true;
  }
  if (type !== PLAYGROUND_SET_MODEL_MESSAGE) return false;
  const message = value as { providerId?: unknown; modelId?: unknown; effort?: unknown };
  const providerId = message.providerId;
  const effort = message.effort;
  return (
    (providerId === 'gemini' ||
      providerId === 'openrouter' ||
      providerId === 'ollama' ||
      providerId === 'llamaServer') &&
    typeof message.modelId === 'string' &&
    message.modelId.length > 0 &&
    (effort === undefined ||
      effort === 'off' ||
      effort === 'low' ||
      effort === 'medium' ||
      effort === 'high')
  );
}

export function normalizePlaygroundBase(base: string): string {
  if (!base || base === '.') return '/';
  const withLeading = base.startsWith('/') ? base : `/${base}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/**
 * Root-crumb label for the playground breadcrumb rail. Mirrors the
 * embed flag so the crumb reads like the surface it actually is:
 * "Prototype" is Studio's name for the embedded playground iframe
 * (see plans/studio-embed), "Playground" is the standalone app's own
 * name. Both point at the same href — `playgroundHomeHref`.
 */
export function playgroundRootCrumbLabel(embedded: boolean): string {
  return embedded ? 'Prototype' : 'Playground';
}

export function playgroundHomeHref({
  base = '/',
  embedded = false,
  sandboxMode,
}: {
  base?: string;
  embedded?: boolean;
  sandboxMode?: PlaygroundSandboxMode;
} = {}): string {
  const url = new URL(normalizePlaygroundBase(base), 'https://pyric.local');
  if (embedded) url.searchParams.set(STUDIO_EMBED_PARAM, STUDIO_EMBED_VALUE);
  if (sandboxMode) url.searchParams.set(PLAYGROUND_SANDBOX_PARAM, sandboxMode);
  return `${url.pathname}${url.search}`;
}

export function playgroundSessionHref(
  sessionId: string,
  {
    base = '/',
    embedded = false,
    sandboxMode,
  }: {
    base?: string;
    embedded?: boolean;
    sandboxMode?: PlaygroundSandboxMode;
  } = {},
): string {
  const url = new URL(`${normalizePlaygroundBase(base)}playground`, 'https://pyric.local');
  url.searchParams.set('session', sessionId);
  if (embedded) url.searchParams.set(STUDIO_EMBED_PARAM, STUDIO_EMBED_VALUE);
  if (sandboxMode) url.searchParams.set(PLAYGROUND_SANDBOX_PARAM, sandboxMode);
  return `${url.pathname}${url.search}`;
}

export function postStudioSettingsNavigation(section?: StudioSettingsSection): void {
  if (typeof window === 'undefined' || window.parent === window) return;
  const message: StudioNavigateSettingsMessage = {
    type: STUDIO_NAVIGATE_SETTINGS_MESSAGE,
    ...(section ? { section } : {}),
  };
  window.parent.postMessage(message, window.location.origin);
}

export interface PlaygroundBreadcrumbMessage {
  type: typeof PLAYGROUND_BREADCRUMB_MESSAGE;
  /** Root crumb label — "Prototype" when embedded. */
  rootLabel: string;
  /** Root crumb target (the session composer / home). Studio navigates its
   *  iframe here on a root-crumb click. */
  rootHref: string;
  /** Current session title, or null before it hydrates (Studio falls back to
   *  a short id form, same as the in-app rail did). */
  title: string | null;
}

/** playground → Studio: publish the current breadcrumb. No-op outside an
 *  embed (no parent frame). */
export function postPlaygroundBreadcrumb(payload: Omit<PlaygroundBreadcrumbMessage, 'type'>): void {
  if (typeof window === 'undefined' || window.parent === window) return;
  window.parent.postMessage(
    { type: PLAYGROUND_BREADCRUMB_MESSAGE, ...payload },
    window.location.origin,
  );
}
