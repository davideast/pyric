import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { appRegistry } from '../registry/app.ts';
import { authRegistry } from '../registry/auth.ts';
import { messagingRegistry } from '../registry/messaging.ts';
import { allCompatibilityRows, rowsForSurface } from '../registry/index.ts';
import { climbHeaderLines, renderScoreboardMarkdown, scoreBlock } from './generate-docs.ts';

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

    expect(scoreBlock(appRegistry, staleBaseline)).toContain(
      `**Fidelity:** ${pct}% (${conforms} of ${rows.length} tracked claims match production)`,
    );
  });

  it('publishes App against Firebase public runtime and type exports', () => {
    const block = scoreBlock(appRegistry)!;
    expect(block).toContain('**Public surface:** runtime 90% (9/10) · types 66.7% (4/6)');
    expect(block).not.toContain('intended');
    expect(block).not.toContain('39.1%');
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

    expect(renderScoreboardMarkdown()).toContain(
      `| Messaging | 100% (5/5) | 100% (8/8) | ${pct}% (${conforms}/${clientRows.length}) |`,
    );
  });

  it('separates client and admin Messaging populations in the climb header', () => {
    const header = climbHeaderLines(messagingRegistry).join('\n');

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
