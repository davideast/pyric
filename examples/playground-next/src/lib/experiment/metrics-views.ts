/**
 * Metrics views — pure functions over the record store (Epic #505 · M3/#508).
 *
 * The store (M1/#506) holds raw rows; ALL derived metrics ($/correct,
 * s/correct, tok/correct, cache-hit %) are computed here. New view = new
 * function; no re-run, no harness change. The decision grid anchors on
 * correctness and sorts by cost-per-correct.
 */
import type { MetricsRecord } from './metrics-store';

export interface Agg {
  model: string;
  strategy: string;
  variant: string;
  fixtures: number;
  passes: number;
  casesPassed: number;
  casesTotal: number;
  tokMed: number;
  tokTotal: number;
  tokInTotal: number;
  costTotal: number;
  timeMedS: number;
  cachedTotal: number;
  // derived (null when undefined, e.g. 0 passes)
  costPerCorrect: number | null;
  secPerCorrect: number | null;
  tokPerCorrect: number | null;
  cacheHitPct: number | null;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Group records by (model · strategy · variant) and derive metrics. */
export function aggregate(records: MetricsRecord[]): Agg[] {
  const groups = new Map<string, MetricsRecord[]>();
  for (const r of records) {
    const k = `${r.model.id}\u0000${r.strategy.name}\u0000${r.variant}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: Agg[] = [];
  for (const [k, rs] of groups) {
    const [model, strategy, variant] = k.split('\u0000') as [string, string, string];
    const passes = rs.filter((r) => r.correctness.ok).length;
    const tokTotal = rs.reduce((a, r) => a + r.tokens.total, 0);
    const tokInTotal = rs.reduce((a, r) => a + r.tokens.in, 0);
    const cachedTotal = rs.reduce((a, r) => a + r.tokens.cached, 0);
    const costTotal = rs.reduce((a, r) => a + r.costUsd, 0);
    const timeTotalS = rs.reduce((a, r) => a + r.durationMs, 0) / 1000;
    out.push({
      model,
      strategy,
      variant,
      fixtures: rs.length,
      passes,
      casesPassed: rs.reduce((a, r) => a + r.correctness.casesPassed, 0),
      casesTotal: rs.reduce((a, r) => a + r.correctness.casesTotal, 0),
      tokMed: median(rs.map((r) => r.tokens.total)),
      tokTotal,
      tokInTotal,
      costTotal,
      timeMedS: median(rs.map((r) => r.durationMs)) / 1000,
      cachedTotal,
      costPerCorrect: passes > 0 ? (costTotal > 0 ? costTotal / passes : 0) : null,
      secPerCorrect: passes > 0 ? timeTotalS / passes : null,
      tokPerCorrect: passes > 0 ? tokTotal / passes : null,
      cacheHitPct: tokInTotal > 0 ? (cachedTotal / tokInTotal) * 100 : null,
    });
  }
  return out;
}

/** Sort: lower cost-per-correct first; 0-pass rows last; cost ties → more passes. */
export function sortByCostPerCorrect(rows: Agg[]): Agg[] {
  return [...rows].sort((a, b) => {
    const av = a.costPerCorrect, bv = b.costPerCorrect;
    if (av === null && bv === null) return b.passes - a.passes;
    if (av === null) return 1;
    if (bv === null) return -1;
    return av - bv || b.passes - a.passes;
  });
}

const money = (n: number | null) => (n === null ? '—' : n === 0 ? '—' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

// ── renderers (markdown/terminal) ────────────────────────────────────────

export function renderDecisionGrid(records: MetricsRecord[]): string {
  const rows = sortByCostPerCorrect(aggregate(records));
  const head = '| model · strategy · variant | correct | tok(med) | cost | time(med) | $/correct | s/correct | cache% |';
  const sep = '|---|---|---|---|---|---|---|---|';
  const body = rows.map((a) =>
    `| ${a.model} · ${a.strategy} · ${a.variant} | ${a.passes}/${a.fixtures} | ${k(a.tokMed)} | ${money(a.costTotal)} | ${a.timeMedS.toFixed(1)}s | ${money(a.costPerCorrect)} | ${a.secPerCorrect === null ? '—' : a.secPerCorrect.toFixed(1) + 's'} | ${a.cacheHitPct === null ? '—' : a.cacheHitPct.toFixed(0) + '%'} |`,
  );
  return ['## Decision grid (sorted by $/correct)', head, sep, ...body].join('\n');
}

export function renderDrillDown(records: MetricsRecord[], sel: { model?: string; strategy?: string; variant?: string }): string {
  const rs = records.filter(
    (r) => (!sel.model || r.model.id === sel.model) && (!sel.strategy || r.strategy.name === sel.strategy) && (!sel.variant || r.variant === sel.variant),
  );
  const head = '| fixture | pass | cases | tok | cost | time |';
  const body = rs.map((r) =>
    `| ${r.fixture.id} | ${r.correctness.ok ? '✓' : '✗'} | ${r.correctness.casesPassed}/${r.correctness.casesTotal} | ${k(r.tokens.total)} | ${money(r.costUsd)} | ${(r.durationMs / 1000).toFixed(1)}s |`,
  );
  return [`## Drill-down ${sel.model ?? ''} · ${sel.strategy ?? ''} ${sel.variant ?? ''}`.trim(), head, '|---|---|---|---|---|---|', ...body].join('\n');
}

export function renderRollup(records: MetricsRecord[], by: 'model' | 'strategy'): string {
  const rows = aggregate(records);
  const groups = new Map<string, Agg[]>();
  for (const a of rows) (groups.get(a[by]) ?? groups.set(a[by], []).get(a[by])!).push(a);
  const lines = [...groups].map(([name, gs]) => {
    const passes = gs.reduce((x, g) => x + g.passes, 0);
    const fixtures = gs.reduce((x, g) => x + g.fixtures, 0);
    const cost = gs.reduce((x, g) => x + g.costTotal, 0);
    return `| ${name} | ${passes}/${fixtures} | ${money(cost)} |`;
  });
  return [`## By ${by}`, `| ${by} | correct | cost |`, '|---|---|---|', ...lines].join('\n');
}

export function renderScatter(records: MetricsRecord[]): string {
  const rows = aggregate(records);
  // correctness (x, 0–100%) vs cost ($, log-ish bucket) — text points.
  const lines = rows
    .map((a) => ({ a, pct: a.fixtures ? (a.passes / a.fixtures) * 100 : 0 }))
    .sort((x, y) => y.pct - x.pct)
    .map(({ a, pct }) => `  ${pct.toFixed(0).padStart(3)}% correct · ${money(a.costPerCorrect).padStart(8)}/correct · ${a.model} · ${a.strategy} · ${a.variant}`);
  return ['## Efficiency scatter (correctness vs $/correct)', ...lines].join('\n');
}

export function renderVariantDiff(records: MetricsRecord[], baseline: string, variant: string, sel?: { model?: string; strategy?: string }): string {
  const pick = (v: string) =>
    aggregate(records.filter((r) => r.variant === v && (!sel?.model || r.model.id === sel.model) && (!sel?.strategy || r.strategy.name === sel.strategy)));
  const a = pick(baseline);
  const b = pick(variant);
  const key = (x: Agg) => `${x.model} · ${x.strategy}`;
  const bMap = new Map(b.map((x) => [key(x), x]));
  // $/1M input tokens — turn-count-independent, so it isolates the caching
  // effect from how many turns the run happened to take.
  const perM = (g: Agg) => (g.tokInTotal > 0 && g.costTotal > 0 ? g.costTotal / (g.tokInTotal / 1e6) : null);
  const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(0)}%`);
  const perMStr = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`);
  const head = `| model · strategy | correct | cost b→v | $/1M-in b→v (turn-indep) | cache% b→v |`;
  const body = a.map((x) => {
    const y = bMap.get(key(x));
    if (!y) return `| ${key(x)} | ${x.passes}/${x.fixtures} | ${money(x.costTotal)} → — | — | — |`;
    return `| ${key(x)} | ${x.passes}→${y.passes}/${x.fixtures} | ${money(x.costTotal)} → ${money(y.costTotal)} | ${perMStr(perM(x))} → ${perMStr(perM(y))} | ${pct(x.cacheHitPct)} → ${pct(y.cacheHitPct)} |`;
  });
  return [
    `## Variant diff: ${baseline} → ${variant}`,
    '_$/1M-in is turn-count-independent — it isolates the caching effect from turn-count variance._',
    head,
    '|---|---|---|---|---|',
    ...body,
  ].join('\n');
}
