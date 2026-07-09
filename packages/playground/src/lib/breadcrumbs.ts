/**
 * Playground breadcrumb rail — pure derivation logic.
 *
 * The IA is exactly two levels: root (composer/home) → current
 * session. There is no third level — no focused-file or sub-tab
 * crumb — because none of those states are addressable outside the
 * session itself (a file path doesn't survive a fresh `?session=`
 * load the way the session id does), so a deeper crumb would just be
 * decoration, not navigation.
 *
 * This exists because `TopBar` (the old home-link's only home) is
 * hidden entirely in studio-embed mode (see `studio-embed.ts`), and
 * even outside embed the link was a small brand mark easy to miss —
 * once inside a session there was no reliable UI path back to the
 * composer. The rail below renders unconditionally in `StatusBar`,
 * which is not gated on embed mode, so the escape hatch survives
 * both layouts.
 */
import { playgroundHomeHref, playgroundRootCrumbLabel } from './studio-embed';

/** Characters of a session id kept when a session has no usable
 *  title yet (pre-hydration, or a title that somehow came back
 *  blank). Long enough to disambiguate at a glance, short enough to
 *  fit the 28px status rail. */
const SHORT_ID_LENGTH = 8;

export interface PlaygroundCrumb {
  label: string;
  /** `null` means "this is the current location" — render as
   *  non-navigating text with `aria-current="page"`, not a link. */
  href: string | null;
}

/**
 * Session crumb label: the session's stored title when it has one,
 * else a short form of its id. Mirrors the title HomePage's recent-
 * sessions list already renders (`SessionMeta.title`, derived from
 * the opening prompt at save time in `lib/sessions/index.ts`) rather
 * than re-deriving a label from prompt text here.
 */
export function deriveSessionCrumbLabel(
  title: string | null | undefined,
  sessionId: string,
): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed;
  return sessionId.length > SHORT_ID_LENGTH
    ? `${sessionId.slice(0, SHORT_ID_LENGTH)}…`
    : sessionId;
}

export interface BuildPlaygroundBreadcrumbsInput {
  /** Astro's `BASE_URL` — where the app is mounted. */
  base: string;
  /** `?embed=studio` — see `isStudioEmbedSearch`. */
  embedded: boolean;
  /** `SessionMeta.title`, or `null` before the session has hydrated. */
  sessionTitle: string | null | undefined;
  sessionId: string;
}

/**
 * Root → current-session crumb list. The root crumb's href is a
 * full-page navigation to the app base (matches the architecture
 * `TopBar`'s Brand link already used) — including inside the Studio
 * iframe, where navigating the iframe's own location is correct;
 * Studio's outer chrome is a separate document. The session crumb
 * has `href: null` — it names "you are here", it doesn't re-navigate
 * to the same page.
 */
export function buildPlaygroundBreadcrumbs({
  base,
  embedded,
  sessionTitle,
  sessionId,
}: BuildPlaygroundBreadcrumbsInput): PlaygroundCrumb[] {
  return [
    {
      label: playgroundRootCrumbLabel(embedded),
      href: playgroundHomeHref({ base, embedded }),
    },
    {
      label: deriveSessionCrumbLabel(sessionTitle, sessionId),
      href: null,
    },
  ];
}
