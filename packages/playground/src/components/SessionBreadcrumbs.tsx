/**
 * Root → session breadcrumb, rendered as `StatusBar`'s `leading`
 * slot (the status rail is the one workbench-chrome element that is
 * NOT hidden in studio-embed mode — see `lib/breadcrumbs.ts` for why
 * this needed a home other than the embed-hidden `TopBar`).
 *
 * Real `<a>` for the root crumb (full-page nav back to the composer,
 * keyboard-focusable, works with cmd/ctrl-click same as any link) and
 * a plain `aria-current="page"` span for the session crumb — it names
 * the current location, it doesn't navigate anywhere.
 */
import { buildPlaygroundBreadcrumbs } from '~/lib/breadcrumbs';

export interface SessionBreadcrumbsProps {
  base: string;
  embedded: boolean;
  sessionTitle: string | null | undefined;
  sessionId: string;
}

export function SessionBreadcrumbs({
  base,
  embedded,
  sessionTitle,
  sessionId,
}: SessionBreadcrumbsProps) {
  const crumbs = buildPlaygroundBreadcrumbs({ base, embedded, sessionTitle, sessionId });

  return (
    <nav
      aria-label="Playground breadcrumb"
      className="flex items-center gap-1 min-w-0 shrink-0 sm:shrink"
    >
      {crumbs.map((crumb, i) => (
        <span key={i} className="flex items-center gap-1 min-w-0">
          {i > 0 ? (
            <span aria-hidden className="text-slate-gray/60 text-[11px] shrink-0">
              /
            </span>
          ) : null}
          {crumb.href ? (
            <a
              href={crumb.href}
              className="text-[11px] font-mono text-slate-gray hover:text-soft-white transition-colors shrink-0"
            >
              {crumb.label}
            </a>
          ) : (
            <span
              aria-current="page"
              className="text-[11px] font-mono text-soft-white truncate max-w-[140px] sm:max-w-[220px]"
            >
              {crumb.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}
