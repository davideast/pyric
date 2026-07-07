/**
 * Pyric Studio V1 shell: one persistent tab strip plus one active surface.
 * Global settings, metadata, and maintenance controls live in Settings so the
 * service tabs stay focused on their primary work.
 */

import { useCallback, useRef } from 'react';
import { DevSeedProvider, useDevSeed } from './dev/DevSeedProvider.js';
import { EnvironmentProvider } from './shell/environment.js';
import { ThemeProvider } from './shell/theme.js';
import { useHashRoute } from './shell/router.js';
import { ROUTE_IDS, ROUTES, findRoute, type RouteId } from './shell/routes.js';
import { IconKey, IconSettings, IconUser } from './shell/icons.js';
import { FirestorePane, StoragePane } from './components/panes.js';
import { AuthSurface } from './features/auth/index.js';
import { TrafficSurface } from './features/traffic/index.js';
import { HomeSurface } from './features/home/HomeSurface.js';
import { RtdbSurface } from './features/rtdb/RtdbSurface.js';
import {
  PlaygroundSurface,
  postPlaygroundCommand,
  type PlaygroundCommandMessage,
} from './features/playground/PlaygroundSurface.js';
import { PlaygroundModelControl } from './features/playground/PlaygroundModelControl.js';
import { SettingsSurface } from './features/settings/SettingsSurface.js';

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
 * from the dev-seed (or `serve --ui` env) via the studio-data bridge. The shell
 * owns routing; surfaces never touch it.
 */
function Surface({
  id,
  navigate,
}: {
  id: string;
  navigate: (id: RouteId) => void;
}) {
  switch (id) {
    case 'home':
      return <HomeSurface onNavigate={navigate} />;
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
    case 'settings':
      return <SettingsSurface />;
    default:
      return <RoutePlaceholder id={id} />;
  }
}

function Shell() {
  const [active, navigateRoute] = useHashRoute(ROUTE_IDS, 'home');
  const playgroundFrameRef = useRef<HTMLIFrameElement | null>(null);
  const navigate = (id: RouteId) => navigateRoute(id);
  const sendPlaygroundCommand = useCallback((message: PlaygroundCommandMessage) => {
    postPlaygroundCommand(playgroundFrameRef.current, message);
  }, []);
  return (
    <div className="studio" data-surface={active}>
      <header className="studio__bar">
        <div className="studio__bar-inner">
          <nav className="studio__nav" aria-label="Studio tabs">
            {ROUTES.map((r) => (
              <button
                key={r.id}
                type="button"
                className="studio__nav-tab"
                aria-current={r.id === active ? 'page' : undefined}
                onClick={() => navigate(r.id)}
              >
                {r.label}
              </button>
            ))}
          </nav>
          <div className="studio__bar-actions" aria-label="Studio actions">
            {active === 'playground' ? (
              <div className="studio__playground-actions" aria-label="Playground controls">
                <PlaygroundModelControl onCommand={sendPlaygroundCommand} />
                <button
                  type="button"
                  className="studio-icon-button"
                  aria-label="Playground API keys"
                  title="API keys"
                  onClick={() => sendPlaygroundCommand({ type: 'pyric:playground:open-keys' })}
                >
                  <IconKey />
                </button>
                <button
                  type="button"
                  className="studio-icon-button"
                  aria-label="Playground settings"
                  title="Playground settings"
                  onClick={() => sendPlaygroundCommand({ type: 'pyric:playground:open-settings' })}
                >
                  <IconSettings />
                </button>
                <button
                  type="button"
                  className="studio-icon-button"
                  aria-label="Playground account"
                  title="Account"
                  onClick={() => sendPlaygroundCommand({ type: 'pyric:playground:open-account' })}
                >
                  <IconUser />
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className="studio__content" data-surface={active}>
        <div
          className="studio__surface-slot studio__surface-slot--playground"
          data-active={active === 'playground' ? 'true' : 'false'}
          aria-hidden={active === 'playground' ? undefined : true}
        >
          <PlaygroundSurface
            frameRef={playgroundFrameRef}
            onNavigateSettings={() => navigate('settings')}
          />
        </div>
        {active !== 'playground' ? (
          <div className="studio__surface-slot" data-active="true">
            <Surface id={active} navigate={navigate} />
          </div>
        ) : null}
      </main>
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
