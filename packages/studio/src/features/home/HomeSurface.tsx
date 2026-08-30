/**
 * Home — the hub (specs/home.md): "what is happening in my sandbox, and what
 * do I do next?".
 *
 * Rows: command | status | body. The command input is the one primary action
 * (C4) and is a deterministic router over tabs + deep-link patterns only (M4;
 * see `command.ts`). The status strip is a compact row of chips, each linking
 * to its surface. The body is the live activity feed (capped; full history
 * lives in Traffic) plus the surface tiles with live counts where the data
 * layer already exposes them. The empty state IS the onboarding (C5).
 *
 * All layout is gap-based; every child fills its container (L2/L3).
 */

import { useMemo, type ReactNode } from 'react';
import { ROUTES, type RouteId } from '../../shell/routes.js';
import { hrefFor, pushPath } from '../../shell/router.js';
import { useServeInit } from '../../shell/serve-init.js';
import { instanceSlug } from '../../shell/instance-slug.js';
import { setInlineCommandFocus } from '../../shell/command-k.js';
import {
  useSandboxInstanceId,
  useStudioDataSource,
  useStudioEvents,
} from '../../shell/studio-data.js';
import { useDevSeed } from '../../dev/DevSeedProvider.js';
import type { CommandTarget } from './command.js';
import { CommandTypeahead } from './CommandTypeahead.js';
import { selectActivity } from './activity.js';
import './home.css';

const FEED_CAP = 20;

function go(target: CommandTarget): void {
  pushPath(target);
}

/** An in-app link: real href (shareable), SPA navigation on click. */
function RouteLink({
  target,
  className,
  children,
  title,
}: {
  target: CommandTarget;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <a
      className={className}
      href={hrefFor(target)}
      title={title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        go(target);
      }}
    >
      {children}
    </a>
  );
}

// ─── Status strip (secondary) ───────────────────────────────────────────────

function StatusStrip() {
  const seed = useDevSeed();
  const serve = useServeInit();
  const instanceId = useSandboxInstanceId();

  const loading =
    serve.status === 'loading' || seed.status === 'pending';

  if (loading) {
    return (
      <div className="studio-home__status" aria-label="Sandbox status">
        <span className="studio-chip studio-home__skeleton-chip" aria-hidden="true" />
        <span className="studio-chip studio-home__skeleton-chip" aria-hidden="true" />
      </div>
    );
  }

  const chips: ReactNode[] = [];

  if (seed.status === 'ready' && serve.status !== 'ready') {
    chips.push(
      <span key="seed" className="studio-chip" title="In-page seeded sandbox — no server. Data resets on reload.">
        <span className="studio-chip__dot" aria-hidden="true" />
        dev seed · in-page
      </span>,
    );
  }

  if (serve.status === 'ready') {
    const p = serve.payload;
    chips.push(
      <RouteLink
        key="persist"
        className="studio-chip"
        target={{ tab: 'settings' }}
        title="Persistence mode — manage in Settings."
      >
        <span className="studio-chip__dot" aria-hidden="true" />
        {p.persist ? 'persisted to disk' : 'ephemeral'}
      </RouteLink>,
    );
    if (p.rulesHash) {
      // Informational only: no Rules surface exists yet to link to, and
      // repo↔sandbox drift isn't cheaply derivable here (spec deviation
      // noted in the report).
      chips.push(
        <span key="rules" className="studio-chip" title="Hash of the rules this serve deployed to the sandbox.">
          <span className="studio-chip__dot" aria-hidden="true" />
          rules {p.rulesHash.slice(0, 8)}
        </span>,
      );
    }
  }

  if (instanceId) {
    chips.push(
      <RouteLink
        key="instance"
        className="studio-chip"
        target={{ tab: 'settings' }}
        title={`Sandbox instance ${instanceId} — maintenance lives in Settings.`}
      >
        <span className="studio-chip__dot" aria-hidden="true" />
        {instanceSlug(instanceId)}
      </RouteLink>,
    );
  }

  return (
    <div className="studio-home__status" aria-label="Sandbox status">
      {chips}
    </div>
  );
}

// ─── Activity feed (primary) ────────────────────────────────────────────────

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

function ActivityFeed() {
  const events = useStudioEvents();
  const rows = useMemo(() => selectActivity(events, FEED_CAP), [events]);

  return (
    <section className="studio-panel studio-home__feed" aria-label="Live activity">
      <header className="studio-home__feed-head">
        <h2 className="studio-panel__title studio-home__feed-title">Activity</h2>
        <RouteLink className="studio-home__feed-all" target={{ tab: 'traffic' }}>
          view all in Traffic →
        </RouteLink>
      </header>
      {rows.length === 0 ? (
        <p className="studio-home__feed-empty">
          No activity yet — writes, denials, and seeds show up here live.
        </p>
      ) : (
        // The scroll owner (L5): the LIST scrolls past ~10 rows; the header
        // (with "view all in Traffic") stays pinned outside the scroll region.
        <div className="studio-home__feed-scroll">
          <ol className="studio-home__feed-list">
          {rows.map((row) => {
            const cells = (
              <>
                <span
                  className="studio-home__feed-ident"
                  data-provenance={row.provenance}
                >
                  <span className="studio-home__feed-dot" aria-hidden="true" />
                  {row.identity}
                </span>
                <span
                  className="studio-home__feed-summary"
                  data-denied={row.denied ? 'true' : undefined}
                >
                  {row.summary}
                </span>
                <time className="studio-home__feed-time" dateTime={new Date(row.at).toISOString()}>
                  {timeOf(row.at)}
                </time>
              </>
            );
            return (
              <li key={row.id}>
                {row.target ? (
                  <RouteLink className="studio-home__feed-row" target={row.target}>
                    {cells}
                  </RouteLink>
                ) : (
                  <span className="studio-home__feed-row">{cells}</span>
                )}
              </li>
            );
          })}
          </ol>
        </div>
      )}
    </section>
  );
}

// ─── Tiles (secondary) ──────────────────────────────────────────────────────

const TILE_IDS: readonly RouteId[] = [
  'firestore',
  'auth',
  'rtdb',
  'storage',
  'traffic',
];

function Tiles() {
  const data = useStudioDataSource();
  const events = useStudioEvents();

  // Live counts only where the data layer already exposes them cheaply:
  // root-collection count (sync on the handles) and the event count. No new
  // counting infrastructure (specs/home.md).
  const counts = useMemo<Partial<Record<RouteId, string>>>(() => {
    const out: Partial<Record<RouteId, string>> = {};
    if (data.status === 'ready') {
      const n = data.handles.listRootCollections().length;
      out.firestore = `${n} collection${n === 1 ? '' : 's'}`;
    }
    if (events.length) out.traffic = `${events.length} events`;
    return out;
  }, [data, events]);

  return (
    <div className="studio-home__tiles">
      {TILE_IDS.map((id) => {
        const route = ROUTES.find((r) => r.id === id);
        if (!route) return null;
        return (
          <RouteLink key={id} className="studio-card studio-home__tile" target={{ tab: id }}>
            <span className="studio-home__tile-top">
              <span className="studio-home__tile-label">{route.label}</span>
              {counts[id] ? <span className="studio-badge">{counts[id]}</span> : null}
            </span>
            <span className="studio-home__tile-desc">{route.description}</span>
          </RouteLink>
        );
      })}
    </div>
  );
}

// ─── Empty state = onboarding (C5) ──────────────────────────────────────────

function OnboardingCards() {
  const serve = useServeInit();
  const served = serve.status === 'ready';
  const bridgeOn = served && !!serve.payload.bridgeUrl;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const rulesHash = served ? serve.payload.rulesHash : null;

  return (
    <>
      <section className="studio-card studio-home__onboard" aria-label="Connect your agent">
        <span className="studio-home__tile-label">Connect your agent</span>
        <span className="studio-home__tile-desc">
          Point Claude Code, Cursor, or any MCP client at this sandbox and its
          writes show up in the feed, attributed.
        </span>
        <code className="studio-home__snippet">
          {bridgeOn ? `${origin}/__pyric/mcp` : 'pyric sandbox --bridge  # then <url>/__pyric/mcp'}
        </code>
      </section>
      <section className="studio-card studio-home__onboard" aria-label="Seed data">
        <span className="studio-home__tile-label">Seed data</span>
        <span className="studio-home__tile-desc">
          Start from a fixture, or create documents by hand in the Firestore
          browser.
        </span>
        <code className="studio-home__snippet">pyric sandbox --seed seed.json</code>
        <RouteLink className="studio-home__onboard-link" target={{ tab: 'firestore' }}>
          open Firestore →
        </RouteLink>
      </section>
      <section className="studio-card studio-home__onboard" aria-label="Bring your rules">
        <span className="studio-home__tile-label">Bring your rules</span>
        {rulesHash ? (
          <span className="studio-home__tile-desc">
            Your repo rules are deployed to this sandbox ({rulesHash.slice(0, 8)}).
            Denials will appear in the feed and in Traffic.
          </span>
        ) : (
          <>
            <span className="studio-home__tile-desc">
              Serve your repo&apos;s rules file and every denial becomes a
              debuggable event.
            </span>
            <code className="studio-home__snippet">pyric.json: {`{"rules":"firestore.rules"}`}</code>
          </>
        )}
      </section>
    </>
  );
}

// ─── The surface ────────────────────────────────────────────────────────────

export function HomeSurface() {
  const data = useStudioDataSource();
  const events = useStudioEvents();
  const seed = useDevSeed();

  const loading = data.status === 'pending' || seed.status === 'pending';
  const fresh =
    !loading &&
    events.length === 0 &&
    (data.status !== 'ready' || data.handles.listRootCollections().length === 0);

  return (
    <section className="studio-surface studio-home" aria-label="Home">
      <div className="studio-home__hero">
        <img
          className="studio-home__hero-logo"
          src={`${import.meta.env.BASE_URL}pyric-logo.svg`}
          alt=""
          aria-hidden="true"
        />
        <h1 className="studio-home__hero-title">Firebase tooling for the agent era</h1>
      </div>
      {/* The typeahead's INLINE mount; ⌘K on Home focuses it via the
          registered handle (shell/command-k.ts) instead of overlaying. */}
      <CommandTypeahead exposeFocus={setInlineCommandFocus} />
      <StatusStrip />
      <div className="studio-home__body">
        {loading ? (
          <section className="studio-panel studio-home__feed studio-home__skeleton" aria-hidden="true">
            <div className="studio-home__skeleton-row" />
            <div className="studio-home__skeleton-row" />
            <div className="studio-home__skeleton-row" />
          </section>
        ) : fresh ? (
          <OnboardingCards />
        ) : (
          <>
            <ActivityFeed />
            <Tiles />
          </>
        )}
      </div>
    </section>
  );
}
