/**
 * Pyric Studio shell: the C-parti (Phase 0, F-SHELL).
 *
 * The layout the mocks share (`design rationale*.html`):
 *   1. PROMPT SPINE   : brand + the "Search, filter, or run a command…" input +
 *                       the ⌘K hint.
 *   2. FRAME BAR      : session context (`notes-app · sandbox, started … ·
 *                       Sandbox · Review · counts`) + the route nav + the theme
 *                       switch + a reset.
 *   3. CONTENT REGION : the active surface. Phase 0 renders a labelled empty
 *                       placeholder per hash route; Wave 2 fills each one.
 *
 * Composition:
 *   <ThemeProvider>          : adaptive light/dark/system, persisted (F-THEME).
 *     <DevSeedProvider>      : in-page seeded sandbox so it renders for review.
 *       <EnvironmentProvider>: the real `createStudioEnvironment` seam (kept
 *                              working; surfaces use it in `pyric serve --ui`).
 *         <Shell/>           : the C-parti, hash-routed.
 *
 * All styling rides `styles/index.css` (the ported mock CSS, token roles only).
 */

import { useEffect, useState } from 'react';
import { DevSeedProvider, useDevSeed } from './dev/DevSeedProvider.js';
import { EnvironmentProvider } from './shell/environment.js';
import { ThemeProvider } from './shell/theme.js';
import { ThemeSwitcher } from './shell/ThemeSwitcher.js';
import { IconCommand, IconSettings, IconMenu, IconClose } from './shell/icons.js';
import { CommandPalette } from './shell/CommandPalette.js';
import { useHashRoute } from './shell/router.js';
import { ROUTE_IDS, ROUTES, findRoute } from './shell/routes.js';
import { FirestorePane, StoragePane } from './components/panes.js';
import { SessionSurface } from './features/session/index.js';
import { AuthSurface } from './features/auth/index.js';
import { RulesSurface } from './features/rules/index.js';
import { TrafficSurface } from './features/traffic/index.js';
import { ReviewSurface } from './features/proposals/ReviewSurface.js';
import { useGovernanceMode } from './features/proposals/proposals.js';
import { usePromptStaging } from './features/proposals/agent.js';
import { SettingsModal } from './ai/SettingsModal.js';
import { useSettingsOpen, openSettings, closeSettings } from './ai/settings-store.js';

/** The labelled empty placeholder a route shows until its surface lands. */
function RoutePlaceholder({ id }: { id: string }) {
  const route = findRoute(id);
  const seed = useDevSeed();

  // Honest, mechanical facts about the seeded fixture so the placeholder proves
  // the data context is wired (counts come straight off the live handles).
  const meta: string[] = [`route #${route.id}`, route.filledBy];
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
      <p className="studio__placeholder-blurb">{route.blurb}</p>
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
 * from the dev-seed (or `serve --ui` env) via the studio-data bridge. The shell
 * owns routing; surfaces never touch it.
 */
function Surface({ id }: { id: string }) {
  switch (id) {
    case 'session':
      return <SessionSurface />;
    case 'firestore':
      return <FirestorePane />;
    case 'auth':
      return <AuthSurface />;
    case 'storage':
      return <StoragePane />;
    case 'traffic':
      return <TrafficSurface />;
    case 'rules':
      return <RulesSurface />;
    case 'review':
      return <ReviewSurface />;
    default:
      return <RoutePlaceholder id={id} />;
  }
}

function Shell() {
  const [active, navigate] = useHashRoute(ROUTE_IDS, ROUTE_IDS[0]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false); // mobile nav drawer
  const settingsOpen = useSettingsOpen();
  const { mode, setMode } = useGovernanceMode();
  const promptStaging = usePromptStaging();

  // ⌘K / Ctrl-K opens the palette anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="studio" data-surface={active}>
      {/* One bar, its content aligned to the same centered column as the surface
          below. Nothing here that isn't load-bearing; session counts + reset
          live in the Session surface. */}
      <header className="studio__bar">
        <div className="studio__bar-inner">
          <span className="studio__brand">Pyric Studio</span>
          <span className="studio__ctx">
            {/* The sandbox mode/project label. The INSTANCE identity (which of
                several same-port sandboxes this is) lives in the Session surface,
                not here. TODO: read the real project from the bridge when set. */}
            <span className="studio__ctx-project">sandbox</span>
          </span>

          {/* Hamburger (mobile only): toggles the nav as a slide-from-top
              drawer, so the bar never overflows on a phone. */}
          <button
            type="button"
            className="studio__iconbtn studio__menu"
            aria-label="Surfaces"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((o) => !o)}
          >
            {navOpen ? <IconClose /> : <IconMenu />}
          </button>

          <nav className="studio__nav" data-open={navOpen ? '' : undefined} aria-label="Surfaces">
            {ROUTES.filter((r) => !r.hidden).map((r) => (
              <button
                key={r.id}
                type="button"
                className="studio__nav-tab"
                aria-current={r.id === active ? 'page' : undefined}
                onClick={() => {
                  navigate(r.id);
                  setNavOpen(false);
                }}
              >
                {r.label}
              </button>
            ))}
          </nav>

          <div className="studio__bar-tools">
            {/* Governance: are staged changes gated by review, or applied
                directly? A real, functional toggle (persisted). */}
            <div className="studio__mode" role="group" aria-label="Change governance">
              <button
                type="button"
                className="studio__mode-opt"
                aria-pressed={mode === 'review'}
                onClick={() => setMode('review')}
                title="Changes run on a copy and need review before they land"
              >
                Review
              </button>
              <button
                type="button"
                className="studio__mode-opt"
                aria-pressed={mode === 'direct'}
                onClick={() => setMode('direct')}
                title="Changes apply directly to live, with no review step"
              >
                Direct
              </button>
            </div>
            <button
              type="button"
              className="studio__iconbtn"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open the command palette (Cmd K)"
              title="Command palette: describe a change or jump to a surface (⌘K)"
            >
              <IconCommand />
            </button>
            <button
              type="button"
              className="studio__iconbtn"
              onClick={openSettings}
              aria-label="AI settings"
              title="AI settings (keys + model)"
            >
              <IconSettings />
            </button>
            <ThemeSwitcher />
          </div>
        </div>
      </header>

      {/* Tap-outside to close the mobile nav drawer (mobile-only via CSS). */}
      {navOpen ? (
        <div
          className="studio__nav-backdrop"
          aria-hidden
          onClick={() => setNavOpen(false)}
        />
      ) : null}

      {/* Content region: one surface, framed per route (width + height). */}
      <main className="studio__content" data-surface={active}>
        <Surface id={active} />
      </main>

      <CommandPalette
        open={paletteOpen}
        active={active}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
        onRunPrompt={promptStaging.run}
        onOpenSettings={openSettings}
        runBlurb={mode === 'direct' ? 'Applies directly to live' : 'Runs on a copy for review'}
      />

      <SettingsModal open={settingsOpen} onClose={closeSettings} />
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
