import { ROUTES, type RouteId } from '../../shell/routes.js';

const HOME_TILE_IDS: readonly RouteId[] = [
  'firestore',
  'auth',
  'storage',
  'rtdb',
  'traffic',
  'playground',
];

export function HomeSurface({ onNavigate }: { onNavigate: (id: RouteId) => void }) {
  const tiles = HOME_TILE_IDS.map((id) => ROUTES.find((route) => route.id === id)).filter(
    (route): route is (typeof ROUTES)[number] => !!route,
  );

  return (
    <section className="studio-surface studio-home" aria-labelledby="studio-home-title">
      <div className="studio-surface__intro">
        <p className="studio-surface__eyebrow">Pyric Studio</p>
        <h1 id="studio-home-title" className="studio-surface__title">
          Choose the surface for the job.
        </h1>
        <p className="studio-surface__copy">
          Studio is focused on the sandbox workbench: data, identity, files,
          traffic, and the full playground workbench. Configuration lives in Settings.
        </p>
      </div>

      <div className="studio-grid studio-home__grid">
        {tiles.map((route) => (
          <button
            key={route.id}
            type="button"
            className="studio-card studio-home__tile"
            data-route={route.id}
            onClick={() => {
              if (route.status !== 'coming-soon') onNavigate(route.id);
            }}
            aria-disabled={route.status === 'coming-soon'}
          >
            <span className="studio-home__tile-top">
              <span className="studio-home__tile-label">{route.label}</span>
              {route.status === 'coming-soon' ? (
                <span className="studio-badge">Coming soon</span>
              ) : null}
            </span>
            <span className="studio-home__tile-desc">{route.description}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
