/**
 * Canonical metrics record + append-only NDJSON store (Epic #505 · issue M1/#506).
 *
 * One `MetricsRecord` per `model × strategy × fixture × trial`. The store is
 * deliberately dumb: it persists raw rows and reads them back. ALL derived
 * metrics ($/correct, s/correct, cache-hit %, …) are computed by the view
 * layer (issue M3/#508), never stored — that's what keeps the data flexible
 * across many views. The `variant` field (e.g. 'baseline', 'caching') is the
 * key that lets one store double as the before/after ledger for the
 * efficiency fixes (E1–E5).
 *
 * Node-only (fs). Imported by scripts, never by browser app code.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';

export interface MetricsRecord {
  // ── identity / config (what was run) ──────────────────────────────────
  runId: string;
  ranAt: string; // ISO-8601
  gitSha: string;
  model: { id: string; endpoint: string; paid: boolean };
  strategy: { name: string; params?: Record<string, unknown> };
  fixture: { id: string; domain?: string; auth?: string; security?: string; tier?: number };
  trial: number;
  /** Which efficiency settings were active — the before/after key. */
  variant: string;

  // ── correctness (the anchor) ──────────────────────────────────────────
  correctness: { ok: boolean; casesPassed: number; casesTotal: number; oracleError?: string };

  /** W0 app-oracle dimensions (workstation-benchmarks.md). Optional and
   *  ADDITIVE: rows recorded before W0 simply lack it. Reported separately
   *  from `correctness` — never collapse the vector into one boolean. */
  appOracle?: {
    compileOk: boolean;
    renderOk: boolean;
    compileError?: string;
    renderError?: string;
    htmlBytes?: number;
  };

  /** T4 retrofit dimension (workstation-benchmarks.md section 3a): the fixture's
   *  PRE-EXISTING workspace tests (from `initialWorkspace`) re-run against
   *  the FINAL rules after the agent finishes — "did the agent break what
   *  already worked". Optional and ADDITIVE: only retrofit fixtures (ones
   *  that declare an initialWorkspace) record it. */
  retrofit?: { priorTestsTotal: number; priorTestsPassed: number };

  // ── cost metrics ──────────────────────────────────────────────────────
  tokens: { in: number; out: number; cached: number; reasoning: number; total: number };
  /** Real provider cost (USD). 0 for local/free models. */
  costUsd: number;
  costSource: 'usage.cost' | 'estimated' | 'none';
  durationMs: number;
  /** Model round-trips (turns/iterations). */
  turns: number;
  toolCalls: string[];

  // ── artifacts (optional — drill-down / re-grade) ──────────────────────
  rules?: string;
  files?: string[];
  liveDocs?: number;
  errors?: string[];
}

const HERE = dirname(new URL(import.meta.url).pathname);
/** Default store lives under the eval tree, committable + accumulating. */
export const DEFAULT_STORE = resolve(HERE, '..', '..', '..', 'scripts', 'evals', 'metrics', 'records.ndjson');

/** Best-effort current short git SHA for run attribution. */
export function currentGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Minimal structural validation — enough to reject malformed lines on read
 *  and to guard `appendRecords`. Not a full schema validator. */
export function isMetricsRecord(x: unknown): x is MetricsRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  const obj = (v: unknown) => !!v && typeof v === 'object';
  return (
    typeof r.runId === 'string' &&
    typeof r.ranAt === 'string' &&
    typeof r.variant === 'string' &&
    typeof r.trial === 'number' &&
    obj(r.model) &&
    obj(r.strategy) &&
    obj(r.fixture) &&
    obj(r.correctness) &&
    obj(r.tokens) &&
    typeof r.costUsd === 'number' &&
    typeof r.durationMs === 'number' &&
    typeof r.turns === 'number' &&
    Array.isArray(r.toolCalls)
  );
}

/** Append records as NDJSON (one object per line). Creates the file/dir. */
export function appendRecords(records: MetricsRecord[], file: string = DEFAULT_STORE): void {
  for (const r of records) {
    if (!isMetricsRecord(r)) throw new Error(`appendRecords: malformed record (runId=${(r as { runId?: string })?.runId})`);
  }
  mkdirSync(dirname(file), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  appendFileSync(file, lines + '\n', 'utf8');
}

/** Read every valid record from a file, or from all `*.ndjson` in a dir.
 *  Malformed lines are skipped (the store must survive a partial write). */
export function readAllRecords(pathOrDir: string = DEFAULT_STORE): MetricsRecord[] {
  const files: string[] = [];
  if (existsSync(pathOrDir) && readdirSafe(pathOrDir)) {
    for (const f of readdirSync(pathOrDir)) if (f.endsWith('.ndjson')) files.push(resolve(pathOrDir, f));
  } else if (existsSync(pathOrDir)) {
    files.push(pathOrDir);
  }
  const out: MetricsRecord[] = [];
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const obj = JSON.parse(s);
        if (isMetricsRecord(obj)) out.push(obj);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}

function readdirSafe(p: string): boolean {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
}
