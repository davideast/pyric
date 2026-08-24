/**
 * Pyric Studio shell (specs/shell.md): site bar (Home | Docs | Studio) plus a
 * service rail, then one active surface. The chrome navigates and reports; it
 * does not act (N1/N2): contextual controls live in the surface they act on,
 * and global settings, metadata, and maintenance live in Settings.
 */

import './shell/shell.css';
import { useEffect, useState, type MouseEvent } from 'react';
import { DevSeedProvider, useDevSeed } from './dev/DevSeedProvider.js';
import { EnvironmentProvider } from './shell/environment.js';
import { ThemeProvider } from './shell/theme.js';
import { hrefFor, useRoute } from './shell/router.js';
import { appBase } from './shell/path.js';
import { focusInlineCommand, isCommandK } from './shell/command-k.js';
import { CommandOverlay } from './shell/CommandOverlay.js';
import { ROUTE_IDS, ROUTES, findRoute, type RouteId } from './shell/routes.js';
import { StatusCluster } from './shell/StatusCluster.js';
import { FirestorePane, StoragePane } from './components/panes.js';
import { AuthSurface } from './features/auth/index.js';
import { TrafficSurface } from './features/traffic/index.js';
import { HomeSurface } from './features/home/HomeSurface.js';
import { RtdbSurface } from './features/rtdb/RtdbSurface.js';
import { SettingsSurface } from './features/settings/SettingsSurface.js';
import { AssuranceSurface } from './features/assurance/index.js';

function siteHomeHref(): string {
  return appBase();
}

/**
 * The docs site is static pages composed alongside Studio under the same
 * base (`<base>/docs`), not a Studio surface — so its "tab" is a plain
 * full-page link. The docs pages render the same site bar, so navigation
 * round-trips.
 */
function docsHref(): string {
  return `${appBase()}docs`;
}

function spaClick(navigate: () => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate();
  };
}

/**
 * Are docs actually composed alongside this Studio? Both supported Astro
 * targets ship them, but Studio remains a reusable React module and a partial
 * deployment could omit them. Probe `<base>/docs/index.json` (the docs search
 * index) and require a JSON content-type: an SPA fallback can answer any miss
 * with the shell's `text/html`, so a bare 200 proves nothing. The tab renders
 * only after the probe confirms the docs tree is present.
 */
function useDocsAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let on = true;
    fetch(`${docsHref()}/index.json`, { method: 'HEAD' })
      .then((res) => {
        const type = res.headers.get('content-type') ?? '';
        if (on && res.ok && type.includes('json')) setAvailable(true);
      })
      .catch(() => {
        // unreachable → no docs; the tab stays hidden
      });
    return () => {
      on = false;
    };
  }, []);
  return available;
}

/** The labelled empty placeholder a route shows until its surface lands. */
function RoutePlaceholder({ id }: { id: string }) {
  const route = findRoute(id);
  const seed = useDevSeed();

  // Honest, mechanical facts about the seeded fixture so the placeholder proves
  // the data context is wired (counts come straight off the live handles).
  const meta: string[] = [`route #${route.id}`];
  if (seed.status === 'ready') {
    meta.push(`events: ${seed.events.length}`);
    meta.push('dev-seed: ready');
  } else if (seed.status === 'pending') {
    meta.push('dev-seed: seeding…');
  } else if (seed.status === 'error') {
    meta.push('dev-seed: error');
  } else {
    meta.push('dev-seed: off');
  }

  return (
    <section className="studio__placeholder" aria-labelledby={`route-${route.id}`}>
      <p className="studio__placeholder-eyebrow">Surface</p>
      <h2 id={`route-${route.id}`} className="studio__placeholder-title">
        {route.label}
      </h2>
      <p className="studio__placeholder-blurb">{route.description}</p>
      <div className="studio__placeholder-meta">
        {meta.map((m) => (
          <span key={m}>{m}</span>
        ))}
      </div>
    </section>
  );
}

/**
 * The active surface for a route. Each composes `@pyric/ui` and reads live data
 * from the dev-seed (or `dev --ui` env) via the studio-data bridge. The shell
 * owns routing; surfaces never touch it.
 */
function Surface({ id }: { id: string }) {
  switch (id) {
    case 'home':
      return <HomeSurface />;
    case 'firestore':
      return <FirestorePane />;
    case 'auth':
      return <AuthSurface />;
    case 'storage':
      return <StoragePane />;
    case 'rtdb':
      return <RtdbSurface />;
    case 'traffic':
      return <TrafficSurface />;
    case 'assurance':
      return <AssuranceSurface />;
    case 'settings':
      return <SettingsSurface />;
    default:
      return <RoutePlaceholder id={id} />;
  }
}

function Shell() {
  const [active, navigateRoute] = useRoute(ROUTE_IDS, 'home');
  const navigate = (id: RouteId) => navigateRoute(id);
  const [commandOpen, setCommandOpen] = useState(false);
  const docsAvailable = useDocsAvailable();

  // Global ⌘K (Ctrl+K non-mac): on Home it focuses the inline command input;
  // elsewhere it toggles the overlay below the bar. preventDefault ONLY when
  // we actually handled the chord — never fight the browser otherwise.
  const onHome = active === 'home';
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isCommandK(e)) return;
      if (commandOpen) {
        e.preventDefault();
        setCommandOpen(false);
        return;
      }
      if (onHome) {
        if (focusInlineCommand()) e.preventDefault();
        return;
      }
      e.preventDefault();
      setCommandOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onHome, commandOpen]);

  // Navigating away (any path — a selection, a tab click) retires the overlay.
  useEffect(() => {
    if (onHome) setCommandOpen(false);
  }, [onHome]);

  // On narrow screens the rail scrolls; keep the active surface on
  // screen when the route changes instead of letting it sit off-edge.
  useEffect(() => {
    document
      .querySelector('.studio__rail [aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [active]);

  const rail = ROUTES.filter((route) => route.id !== 'home');

  return (
    <div className="studio" data-surface={active}>
      <header className="studio__chrome">
        <div className="studio__bar">
          <div className="studio__chrome-inner">
            <nav className="studio__nav" aria-label="Site">
              <a className="studio__brand" href={siteHomeHref()} aria-label="Pyric">
                pyric
              </a>
              <a className="studio__nav-tab" href={siteHomeHref()}>
                Home
              </a>
              {docsAvailable ? (
                <a className="studio__nav-tab" href={docsHref()}>
                  Docs
                </a>
              ) : null}
              <a
                className="studio__nav-tab"
                href={hrefFor({ tab: 'home' })}
                aria-current={active === 'home' ? 'page' : true}
                onClick={spaClick(() => navigate('home'))}
              >
                Studio
              </a>
            </nav>
            <StatusCluster />
          </div>
        </div>
        <nav className="studio__rail" aria-label="Studio">
          <div className="studio__chrome-inner">
            <div className="studio__nav">
              {rail.map((r) => (
                <a
                  key={r.id}
                  className="studio__nav-tab"
                  href={hrefFor({ tab: r.id })}
                  aria-current={r.id === active ? 'page' : undefined}
                  onClick={spaClick(() => navigate(r.id))}
                >
                  {r.label}
                </a>
              ))}
            </div>
          </div>
        </nav>
      </header>

      <main className="studio__content" data-surface={active}>
        <div className="studio__surface-slot" data-active="true">
          <Surface id={active} />
        </div>
      </main>

      {commandOpen ? <CommandOverlay onClose={() => setCommandOpen(false)} /> : null}
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <DevSeedProvider>
        <EnvironmentProvider mode="local">
          <Shell />
        </EnvironmentProvider>
      </DevSeedProvider>
    </ThemeProvider>
  );
}
