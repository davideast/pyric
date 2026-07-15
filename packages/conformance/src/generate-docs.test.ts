import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { appRegistry } from '../registry/app.ts';
import { authRegistry } from '../registry/auth.ts';
import { messagingRegistry } from '../registry/messaging.ts';
import { allCompatibilityRows, rowsForSurface } from '../registry/index.ts';
import {
  climbHeaderLines,
  consolidatedGapSections,
  renderScoreboardMarkdown,
  renderSurfaceMarkdown,
  scoreBlock,
  statBar,
} from './generate-docs.ts';
import { deriveConformanceModel, type ConformanceModel } from './conformance-model.ts';

let projection: ConformanceModel['documentation'];
beforeAll(async () => { projection = (await deriveConformanceModel()).documentation; }, 20_000);

describe('generated fidelity scores', () => {
  it('uses the live registry rather than the stale coverage baseline', () => {
    const rows = rowsForSurface(appRegistry);
    const conforms = rows.filter((row) => row.status === 'conforms').length;
    const pct = Math.round((conforms / rows.length) * 1000) / 10;
    const staleBaseline = {
      services: {
        app: {
          publicSurface: {
            runtime: { mapped: 10, denominator: 10, pct: 100 },
            types: { mapped: 6, denominator: 6, pct: 100 },
          },
        },
      },
      overall: {
        publicSurface: {
          runtime: { mapped: 10, denominator: 10, pct: 100 },
          types: { mapped: 6, denominator: 6, pct: 100 },
        },
      },
      rowStatuses: {},
    };

    const block = scoreBlock(appRegistry, { ...projection, coverageBaseline: staleBaseline })!;
    expect(block).toContain(`<span class="compat-stat-pct">${pct}%</span>`);
    expect(block).toContain(`<p class="compat-stat-denom">${conforms} of ${rows.length} tracked behaviors</p>`);
  });

  it('publishes App against Firebase public runtime and type exports', () => {
    const block = scoreBlock(appRegistry, projection)!;
    expect(block).toContain('<strong>Public surface:</strong> runtime 90% (9/10)');
    expect(block).toContain('types 66.7% (4/6)');
    expect(block).not.toContain('intended');
    expect(block).not.toContain('39.1%');
  });

  it('renders a proportional bar with an accessible five-state text equivalent', () => {
    const bar = statBar({
      conforms: 5,
      diverged: 4,
      bugs: 3,
      unsupported: 2,
      unverified: 1,
      total: 15,
      pct: 33.3,
    });

    expect(bar).toContain('role="img"');
    expect(bar).toContain('aria-label="Behavior distribution: 5 conform, 4 documented divergences, 3 bugs, 2 unsupported, 1 unverified."');
    expect(bar).toContain('data-status="ok" style="flex-grow: 5"');
    expect(bar).toContain('data-status="diverged" style="flex-grow: 4"');
    expect(bar).toContain('data-status="bug" style="flex-grow: 3"');
    expect(bar).toContain('data-status="unsupported" style="flex-grow: 2"');
    expect(bar).toContain('data-status="unverified" style="flex-grow: 1"');
  });

  it('keeps zero-count states visible in the key without assigning fake bar width', () => {
    const block = scoreBlock(appRegistry, projection)!;

    expect(block).toContain('<strong>0</strong> bugs');
    expect(block).toContain('data-status="bug" aria-hidden="true"');
    expect(block).not.toContain('data-status="bug" style="flex-grow:');
  });

  it('renders API-first matrices and generated non-conforming summaries', () => {
    const markdown = renderSurfaceMarkdown(authRegistry, projection);
    const gaps = consolidatedGapSections(rowsForSurface(authRegistry));

    expect(markdown).toContain('| API | Category | Behavior | Status | Probe | # |');
    expect(markdown).toContain('| signInWithEmailAndPassword(auth, email, password) |');
    expect(gaps).toContain('## Current gaps');
    expect(gaps).toContain('### Documented divergences');
    expect(gaps).toContain('### Unsupported');
    expect(gaps).toContain('### Unverified');
    expect(gaps).not.toContain('### Bugs');
  });

  it('ratchets every oracle-backed conforming row in the coverage baseline', () => {
    const baseline = JSON.parse(readFileSync(
      new URL('../baselines/coverage-baseline.json', import.meta.url),
      'utf8',
    )) as { rowStatuses: Record<string, string> };
    const unprotected = allCompatibilityRows
      .filter((row) => row.status === 'conforms' && row.automation === 'oracle-backed')
      .filter((row) => baseline.rowStatuses[row.id] !== 'conforms')
      .map((row) => row.id);

    expect(unprotected).toEqual([]);
  });

  it('keeps the multi-app Auth claim within the captured session evidence', () => {
    const row = rowsForSurface(authRegistry).find(({ id }) => id === 'auth#183');

    expect(row?.behavior).toContain('independent active Auth sessions');
    expect(row?.behavior).toContain("does not change another app's currentUser");
    expect(row?.behavior).not.toContain('account store');
  });

  it('keeps firebase-admin Messaging rows outside the client mirror scoreboard', () => {
    const clientRows = allCompatibilityRows.filter((row) => row.surface === 'messaging');
    const conforms = clientRows.filter((row) => row.status === 'conforms').length;
    const pct = Math.round((conforms / clientRows.length) * 1000) / 10;

    const scoreboard = renderScoreboardMarkdown(projection);
    expect(scoreboard).toContain('<span class="compat-score-name">Messaging</span>');
    expect(scoreboard).toContain('<span class="compat-score-axis">Runtime</span>100% (5/5)');
    expect(scoreboard).toContain('<span class="compat-score-axis">Types</span>100% (8/8)');
    expect(scoreboard).toContain(`<strong class="compat-score-pct">${pct}%</strong>`);
    expect(scoreboard).toContain(`<span>${conforms}/${clientRows.length} conform</span>`);
  });

  it('keeps Functions with RTDB visible as an integration row', () => {
    const scoreboard = renderScoreboardMarkdown(projection);

    expect(scoreboard).toContain('href="../pyric-cli-functions-rtdb-compat/"');
    expect(scoreboard).toContain('<span class="compat-score-name">Functions · RTDB</span>');
    expect(scoreboard).toContain('<span class="compat-score-axis">Runtime</span>integration');
    expect(scoreboard).toContain('<span class="compat-score-axis">Types</span>integration');
  });

  it('separates client and admin Messaging populations in the climb header', () => {
    const header = climbHeaderLines(messagingRegistry, projection).join('\n');

    expect(header).toContain('Client + service-worker mirror: 17 of 17 rows conforming.');
    expect(header).toContain('Separately tracked Admin send plane: 39 of 39 rows conforming.');
    expect(header).not.toContain('56 of 56 rows conforming.');
  });

  it('documents the published Messaging entry points as available', () => {
    const intro = messagingRegistry.blocks
      .filter((block) => block.kind === 'markdown')
      .map((block) => block.markdown)
      .join('\n');

    expect(intro).toContain('Published and conformance-held');
    expect(intro).not.toContain('not yet in published packages');
    expect(intro).not.toContain('npm does not provide `pyric/messaging`');
  });

  it('describes the real Service Worker witness without claiming bare-import resolution', () => {
    const row = rowsForSurface(messagingRegistry).find(({ id }) => id === 'messaging#13');

    expect(row?.evidence).toContain('real module-ServiceWorker served-entry replay');
    expect(row?.evidence).not.toContain('canonical-import replay');
    expect(row?.notes).toContain('module workers do not inherit the page import map');
    expect(row?.notes).toContain('bundler alias');
  });

  it('keeps the deleted-app AI claim within the captured factory evidence', () => {
    const row = rowsForSurface(appRegistry).find(({ id }) => id === 'app#25');

    expect(row?.behavior).toContain(
      '`getAI(deletedApp)` returns an app-associated handle',
    );
    expect(row?.behavior).not.toContain('AI remain usable');
  });
});
