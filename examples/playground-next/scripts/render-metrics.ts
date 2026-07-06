#!/usr/bin/env bun
/**
 * Render views from the metrics store (Epic #505 · M3/#508). Reads the
 * append-only NDJSON; never runs the agent. New views are pure functions in
 * `src/lib/experiment/metrics-views.ts`.
 *
 * Usage:
 *   bun scripts/render-metrics.ts --view=grid
 *   bun scripts/render-metrics.ts --view=drill --model=moonshotai/kimi-k2.6 --strategy=react
 *   bun scripts/render-metrics.ts --view=per-model
 *   bun scripts/render-metrics.ts --view=variant-diff --variants=baseline,caching --strategy=react
 *   filters: --model= --strategy= --variant= --fixture=   ·  --format=json
 *
 * EFF1 ledger views (read request-ledger.ndjson / tool-ledger.ndjson,
 * filterable by --run=<substring>):
 *   bun scripts/render-metrics.ts --view=tool-sizes        # per-tool result-size p50/p95
 *   bun scripts/render-metrics.ts --view=redundancy        # duplicate simulate tuples + write churn
 *   bun scripts/render-metrics.ts --view=context-integral  # Σ tokensIn vs final per turn (H1)
 */
import { readAllRecords } from '~/lib/experiment/metrics-store';
import { readRequestRows, readToolRows } from '~/lib/experiment/efficiency-ledgers';
import {
  analyzeH1,
  analyzeH2,
  analyzeH5,
  analyzeH7,
  samplesFromToolRows,
} from '~/lib/experiment/trace-analysis';
import {
  aggregate,
  renderDecisionGrid,
  renderDrillDown,
  renderRollup,
  renderScatter,
  renderVariantDiff,
} from '~/lib/experiment/metrics-views';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const view = flag('view') ?? 'grid';
const fModel = flag('model');
const fStrategy = flag('strategy');
const fVariant = flag('variant');
const fFixture = flag('fixture');
const fRun = flag('run');
const format = flag('format') ?? 'md';

// ── EFF1 ledger views — read the ledgers, not the records store ────────
const LEDGER_VIEWS = new Set(['tool-sizes', 'redundancy', 'context-integral']);
if (LEDGER_VIEWS.has(view)) {
  let toolRows = readToolRows();
  let requestRows = readRequestRows();
  if (fRun) {
    toolRows = toolRows.filter((r) => r.runId.includes(fRun));
    requestRows = requestRows.filter((r) => r.runId.includes(fRun));
  }
  const samples = samplesFromToolRows(toolRows);
  const sections =
    view === 'tool-sizes'
      ? [analyzeH2(samples)]
      : view === 'redundancy'
        ? [analyzeH5(samples), analyzeH7(samples)]
        : [analyzeH1(requestRows)];
  for (const s of sections) {
    console.log(`## ${s.hypothesis} — ${s.title}\n\nVerdict: **${s.verdict}** — ${s.headline}\n`);
    if (s.body) console.log(s.body + '\n');
    if (s.missing) console.log(`Missing: ${s.missing}\n`);
  }
  process.exit(0);
}

let records = readAllRecords();
if (fModel) records = records.filter((r) => r.model.id === fModel);
if (fStrategy) records = records.filter((r) => r.strategy.name === fStrategy);
if (fVariant) records = records.filter((r) => r.variant === fVariant);
if (fFixture) records = records.filter((r) => r.fixture.id === fFixture);

if (records.length === 0) {
  console.log('no records match. Run e.g.: bun --env-file=../../.env scripts/run-app-build.ts --local --endpoint=<url> --model=<m> --strategy=react');
  process.exit(0);
}

if (format === 'json') {
  console.log(JSON.stringify(aggregate(records), null, 2));
  process.exit(0);
}

switch (view) {
  case 'grid':
    console.log(renderDecisionGrid(records));
    break;
  case 'drill':
    console.log(renderDrillDown(records, { model: fModel, strategy: fStrategy, variant: fVariant }));
    break;
  case 'per-model':
    console.log(renderRollup(records, 'model'));
    break;
  case 'per-strategy':
    console.log(renderRollup(records, 'strategy'));
    break;
  case 'scatter':
    console.log(renderScatter(records));
    break;
  case 'variant-diff': {
    const [a, b] = (flag('variants') ?? 'baseline,caching').split(',');
    console.log(renderVariantDiff(records, a ?? 'baseline', b ?? 'caching', { model: fModel, strategy: fStrategy }));
    break;
  }
  default:
    console.log(`unknown --view=${view}. options: grid | drill | per-model | per-strategy | scatter | variant-diff | tool-sizes | redundancy | context-integral`);
}
