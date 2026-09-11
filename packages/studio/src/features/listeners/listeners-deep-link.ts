/**
 * The Listeners deep link (the runtime chip, `packages/cli/src/serve/runtime/
 * listener-mode.ts`, opens Studio at `?view=listeners&listener=<id>&target=
 * <path>`).
 *
 * Studio has no URL router for this shape: it's read once at startup from
 * `location.search`, independent of the pathname-based tab route. It is not
 * a general-purpose query codec; it names exactly the three parameters the
 * runtime chip sends.
 */

export interface ListenersDeepLink {
  readonly open: boolean;
  readonly listenerId?: string;
  readonly targetPrefix?: string;
}

const NONE: ListenersDeepLink = { open: false };

/** Parse a `location.search` string (with or without its leading `?`) into
 *  the Listeners deep link, or the closed link when `view` isn't `listeners`. */
export function parseListenersDeepLink(search: string): ListenersDeepLink {
  const params = new URLSearchParams(search);
  if (params.get('view') !== 'listeners') return NONE;
  const link: { open: true; listenerId?: string; targetPrefix?: string } = { open: true };
  const listenerId = params.get('listener');
  if (listenerId !== null && listenerId !== '') link.listenerId = listenerId;
  const targetPrefix = params.get('target');
  if (targetPrefix !== null && targetPrefix !== '') link.targetPrefix = targetPrefix;
  return link;
}

/** The deep link read from the current page load. `location.search` is read
 *  once, at call time; callers that need it at startup call this during
 *  their initial render, not inside an effect. */
export function currentListenersDeepLink(): ListenersDeepLink {
  if (typeof window === 'undefined') return NONE;
  return parseListenersDeepLink(window.location.search);
}
