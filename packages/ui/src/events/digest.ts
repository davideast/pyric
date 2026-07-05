/**
 * The pure activity-digest reducer — folds a `SandboxEvent[]` (the
 * unified stream) into the banded digest the activity grid renders.
 *
 * Kept free of React so it's trivially testable and reusable by a
 * non-React consumer (a CLI session summary, say). `useActivityDigest`
 * is a thin `useMemo` wrapper over `computeActivityDigest`.
 *
 * The categorization is the product (see
 * the design rationale): the can't-miss bands are
 * **denied** (surfaced first, loudly), **added**, **updated**,
 * **removed**, **signed-in / signed-out**, and the catch-alls. Every
 * row + band carries provenance (actor / lens / on-behalf-of) so
 * attribution rides every aggregate, and the band order LEADS with the
 * highest-consequence category present.
 */

import type {
  ActivityActor,
  ActivityEvent,
  ActivityLens,
  ActivityRequestEvent,
  ActivityServiceMutationEvent,
  ActivityWriteEvent,
  AnyActivityEvent,
  ActivityService,
} from './types.js';

/**
 * The band a row falls into. `denied` leads; the write bands
 * (added/updated/removed) and the auth bands (signed-in/signed-out)
 * follow; `read`, `errored`, and `other` are the long-tail catch-alls.
 *
 * - `denied`     — a rules denial (firestore `request` with `result: 'deny'`).
 * - `errored`    — an operational failure (`request` with `result: 'unsupported'`).
 * - `added`      — a doc/object created, or a user created.
 * - `updated`    — a doc/object/user/rtdb path mutated in place.
 * - `removed`    — a doc/object/user deleted.
 * - `signed-in`  — an auth sign-in.
 * - `signed-out` — an auth sign-out.
 * - `read`       — an allowed firestore read (`get`/`list`).
 * - `other`      — anything modelled but uncategorized (e.g. an unknown service op).
 */
export type ActivityBandKey =
  | 'denied'
  | 'errored'
  | 'added'
  | 'updated'
  | 'removed'
  | 'signed-in'
  | 'signed-out'
  | 'read'
  | 'other';

/**
 * A single grid row — the projection of one event onto the
 * `target · change · for · lens · when` column contract from
 * `c-result.html`. All display-ready strings plus the structured
 * provenance the host may style on.
 */
export interface ActivityRow {
  /** The originating event's id — stable React key. */
  id: string;
  /** `Date.now()` at the op. Drives the `when` column + recency sort. */
  at: number;
  /** Which band this row was sorted into. */
  band: ActivityBandKey;
  /** True for denials — first-class so hosts flag the row distinctly. */
  denied: boolean;
  /** Originating service. */
  service: ActivityService;

  // ── The five grid columns (c-result.html) ──────────────────────────
  /** `target` — what was mutated, in the service's addressing scheme
   *  (a doc path `notes/3agHoZHZ`, a `uid`, a storage `fullPath`, an
   *  rtdb path). Empty string when the event has no addressable target. */
  target: string;
  /** `change` — a short human description of the mutation
   *  (`update, owner rule`, `done → true`, `created`, `signed in`). */
  change: string;
  /** `for` — the subject the op acted on behalf of: `request.auth.uid`
   *  for firestore, the affected `uid` for auth, else the acting
   *  identity. Empty when anonymous / not applicable. */
  for: string;
  /** `lens` — the privilege the op ran under, display-ready
   *  (`app`, `as alice`, `admin`). */
  lens: string;
  /** `when` — left undterived here; the grid formats `at` itself, but a
   *  pre-rendered relative string is offered for headless consumers. */
  when: string;

  // ── Structured provenance (for styling / pivots / drill) ───────────
  actor: ActivityActor;
  authLens: ActivityLens;
  /** The on-behalf-of subject uid, structured (mirrors `for`). */
  subjectUid: string | null;
  /** Agent plan id, when the op was part of a plan. */
  planId?: string;
  /** The pivot key this row fell under — set only when the digest was
   *  computed with `groupBy !== 'none'`. Mirrors the row's `subgroup`. */
  groupKey?: string;
  /** The original event, for drill-in. */
  event: ActivityEvent;
}

/**
 * One category band: a header (`label · count · attribution`) plus its
 * rows. Mirrors the mock's `.band` + `.r.data` structure.
 */
export interface ActivityBand {
  key: ActivityBandKey;
  /** Display label — `Denied`, `Added`, `Updated`, … */
  label: string;
  /** Total rows in the band (== `rows.length`; explicit for the header). */
  count: number;
  /** A short attribution phrase when the band has a dominant actor /
   *  subject (`all by alice`, `by the app`, `by agent atlas`). Absent
   *  when attribution is mixed — the header then shows just the count. */
  attribution?: string;
  rows: ActivityRow[];
}

/**
 * The banded digest — the activity grid's entire model. Bands are
 * pre-sorted lead-with-consequence; `denials` is a flat projection of
 * the consequential rows for the action-items tier.
 */
export interface ActivityDigest {
  /** Bands in render order — highest-consequence first. Empty bands
   *  omitted. Each band may carry `subgroups` when `groupBy !== 'none'`. */
  bands: ActivityBandWithGroups[];
  /** Total rows across all bands (events the digest categorized). */
  total: number;
  /** Of those, how many were denials. */
  deniedCount: number;
  /**
   * The denial rows, flat + recency-sorted — the source for the
   * action-items tier ("4 writes to /notes were denied"). A projection,
   * not a separate aggregation: these rows also live in the `denied` band.
   */
  denials: ActivityRow[];
}

/** How rows within each band are pivoted/grouped. */
export type ActivityGroupBy = 'none' | 'actor' | 'lens' | 'subject' | 'service';

export interface ActivityDigestOptions {
  /**
   * Row order within a band. `recency` (default) is newest-first to
   * match the mock's `when` column. `chronological` is oldest-first.
   */
  order?: 'recency' | 'chronological';
  /**
   * Pivot rows within each band by an attribution axis. `'none'`
   * (default) leaves the band flat. Any other value splits each band's
   * rows into sub-groups keyed by that axis — surfaced on the row via
   * `groupKey` and exposed as `band.subgroups`. The flat `rows` are
   * always present regardless.
   */
  groupBy?: ActivityGroupBy;
  /**
   * Cap rows kept per band (the mock shows ~3–4 then "N more"). The
   * digest keeps ALL rows but records the overflow via `band.count` vs
   * `rows.length`. Set to a number to actually trim `rows`; the header
   * `count` still reflects the true total. Default: keep all.
   */
  rowsPerBand?: number;
}

// ── Band ordering: lead-with-consequence ──────────────────────────────
// Lower rank renders first. Denials lead; operational errors next; then
// the write bands; auth; reads; catch-all. (design-ideation.md:
// "the answer LEADS with the highest-consequence category present".)
const BAND_RANK: Record<ActivityBandKey, number> = {
  denied: 0,
  errored: 1,
  added: 2,
  updated: 3,
  removed: 4,
  'signed-in': 5,
  'signed-out': 6,
  read: 7,
  other: 8,
};

const BAND_LABEL: Record<ActivityBandKey, string> = {
  denied: 'Denied',
  errored: 'Errored',
  added: 'Added',
  updated: 'Updated',
  removed: 'Removed',
  'signed-in': 'Signed in',
  'signed-out': 'Signed out',
  read: 'Read',
  other: 'Other',
};

/** The kinds the digest models. Everything else is skipped. */
function isModelled(e: AnyActivityEvent): e is ActivityEvent {
  return (
    e.kind === 'request' ||
    e.kind === 'write' ||
    e.kind === 'service_mutation'
  );
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

function defaultActor(actor: ActivityActor | undefined): ActivityActor {
  return actor ?? { kind: 'app' };
}

function defaultLens(lens: ActivityLens | undefined): ActivityLens {
  return lens ?? { mode: 'app-session' };
}

function lensLabel(lens: ActivityLens): string {
  switch (lens.mode) {
    case 'admin':
      return 'admin';
    case 'as':
      return lens.uid;
    case 'app-session':
      return 'app';
  }
}

function actorLabel(actor: ActivityActor): string {
  switch (actor.kind) {
    case 'app':
      return 'the app';
    case 'studio':
      return 'studio';
    case 'app-builder':
      return 'the app builder';
    case 'agent':
      return `agent ${actor.name}`;
  }
}

/** A stable identity key for an actor (for attribution counting). */
function actorKey(actor: ActivityActor): string {
  return actor.kind === 'agent' ? `agent:${actor.name}` : actor.kind;
}

/** The deciding rule on a denial, parsed from the simulator reasons.
 *  Best-effort — falls back to a generic phrase. */
function denialRulePhrase(reasons: string[]): string | undefined {
  // Reasons look like `Rule #0 (update) → DENY`. We surface the op the
  // rule governs when present; the design copy says "owner rule" but
  // that's app-semantic naming the library can't know, so we stay
  // mechanical: name the failing op.
  for (const r of reasons) {
    const m = /Rule #\d+\s*\(([^)]+)\)/i.exec(r);
    if (m) return `${m[1]} rule`;
  }
  return undefined;
}

function relativeWhen(at: number, now: number): string {
  const deltaMs = Math.max(0, now - at);
  const s = Math.floor(deltaMs / 1000);
  if (s < 1) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

// ── Per-kind projection: event → { band, row fields } ─────────────────

function projectRequest(
  e: ActivityRequestEvent,
): { band: ActivityBandKey; change: string; subjectUid: string | null } {
  if (e.result === 'deny') {
    const rule = denialRulePhrase(e.reasons);
    const change = rule ? `${e.method}, ${rule}` : `${e.method} denied`;
    return { band: 'denied', change, subjectUid: e.auth?.uid ?? null };
  }
  if (e.result === 'unsupported') {
    return {
      band: 'errored',
      change: `${e.method} unsupported`,
      subjectUid: e.auth?.uid ?? null,
    };
  }
  // Allowed request. Reads land in `read`; allowed writes that DIDN'T
  // also emit a `write` event still get a band so nothing is dropped.
  const subjectUid = e.auth?.uid ?? null;
  if (e.method === 'get' || e.method === 'list') {
    return { band: 'read', change: e.method, subjectUid };
  }
  if (e.method === 'delete') {
    return { band: 'removed', change: 'deleted', subjectUid };
  }
  if (e.method === 'create') {
    return { band: 'added', change: 'created', subjectUid };
  }
  return { band: 'updated', change: e.method, subjectUid };
}

/** A compact change summary for a write, diffing prior→next when cheap. */
function writeChange(e: ActivityWriteEvent): string {
  if (e.method === 'delete') return 'deleted';
  if (e.method === 'create') {
    // Surface a representative field value if present (mock shows the
    // note title in quotes). Pick the first string-ish scalar.
    const data = e.nextState ?? e.data ?? null;
    const preview = data ? firstScalarPreview(data) : undefined;
    return preview !== undefined ? preview : 'created';
  }
  // update / set — try to show a single changed field as `key → value`.
  const single = singleFieldDiff(e.priorState, e.nextState);
  if (single) return single;
  return e.method === 'set' ? 'replaced' : 'updated';
}

function firstScalarPreview(data: Record<string, unknown>): string | undefined {
  for (const v of Object.values(data)) {
    if (typeof v === 'string') return `"${v}"`;
  }
  for (const v of Object.values(data)) {
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return undefined;
}

function singleFieldDiff(
  prior: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): string | undefined {
  if (!next) return undefined;
  const before = prior ?? {};
  const changed: string[] = [];
  for (const k of Object.keys(next)) {
    if (!shallowEqual(before[k], next[k])) changed.push(k);
  }
  if (changed.length !== 1) {
    return changed.length > 1 ? `${changed.length} fields changed` : undefined;
  }
  const key = changed[0];
  const v = next[key];
  if (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  ) {
    const shown = typeof v === 'string' ? v : String(v);
    return `${key} → ${shown}`;
  }
  return `${key} changed`;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object' && a && b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function projectWrite(
  e: ActivityWriteEvent,
): { band: ActivityBandKey; change: string; subjectUid: string | null } {
  const subjectUid = e.auth?.uid ?? null;
  if (e.method === 'delete') return { band: 'removed', change: 'deleted', subjectUid };
  if (e.method === 'create') return { band: 'added', change: writeChange(e), subjectUid };
  return { band: 'updated', change: writeChange(e), subjectUid };
}

function projectServiceMutation(
  e: ActivityServiceMutationEvent,
): { band: ActivityBandKey; change: string; subjectUid: string | null } {
  const op = e.op;
  // auth ops carry the affected uid in `path` (or `*` for a clear-all).
  if (e.service === 'auth') {
    const affected = e.path && e.path !== '*' ? e.path : null;
    const subjectUid = affected ?? e.auth?.uid ?? null;
    switch (op) {
      case 'sign_in':
        return { band: 'signed-in', change: 'signed in', subjectUid };
      case 'sign_out':
        return { band: 'signed-out', change: 'signed out', subjectUid };
      case 'user_create':
        return { band: 'added', change: 'user created', subjectUid };
      case 'user_update':
        return { band: 'updated', change: 'user updated', subjectUid };
      case 'user_delete':
        return { band: 'removed', change: 'user deleted', subjectUid };
      case 'users_clear':
        return { band: 'removed', change: 'all users cleared', subjectUid };
      default:
        return { band: 'other', change: op, subjectUid };
    }
  }
  const subjectUid = e.auth?.uid ?? null;
  if (e.service === 'storage') {
    switch (op) {
      case 'object_put':
        // create vs overwrite: `before` present ⇒ overwrite.
        return e.before !== undefined
          ? { band: 'updated', change: 'object replaced', subjectUid }
          : { band: 'added', change: 'object uploaded', subjectUid };
      case 'object_delete':
        return { band: 'removed', change: 'object deleted', subjectUid };
      case 'metadata_update':
        return { band: 'updated', change: 'metadata updated', subjectUid };
      default:
        return { band: 'other', change: op, subjectUid };
    }
  }
  // rtdb
  switch (op) {
    case 'set':
      return e.before !== undefined && e.before !== null
        ? { band: 'updated', change: 'set', subjectUid }
        : { band: 'added', change: 'set', subjectUid };
    case 'update':
      return { band: 'updated', change: 'update', subjectUid };
    case 'remove':
      return { band: 'removed', change: 'removed', subjectUid };
    case 'transaction':
      return { band: 'updated', change: 'transaction', subjectUid };
    default:
      return { band: 'other', change: op, subjectUid };
  }
}

function project(e: ActivityEvent): {
  band: ActivityBandKey;
  change: string;
  subjectUid: string | null;
} {
  switch (e.kind) {
    case 'request':
      return projectRequest(e);
    case 'write':
      return projectWrite(e);
    case 'service_mutation':
      return projectServiceMutation(e);
  }
}

function targetOf(e: ActivityEvent): string {
  switch (e.kind) {
    case 'request':
    case 'write':
      return e.path;
    case 'service_mutation':
      // auth: the affected uid; storage/rtdb: the path.
      if (e.service === 'auth') return e.path && e.path !== '*' ? e.path : '*';
      return e.path ?? '';
  }
}

function serviceOf(e: ActivityEvent): ActivityService {
  if (e.kind === 'service_mutation') return e.service;
  return e.service ?? 'firestore';
}

/** Build a row from a modelled event. */
function toRow(e: ActivityEvent, now: number): ActivityRow {
  const { band, change, subjectUid } = project(e);
  const actor = defaultActor(e.actor);
  const authLens = defaultLens(e.authLens);
  const row: ActivityRow = {
    id: e.id,
    at: e.at,
    band,
    denied: band === 'denied',
    service: serviceOf(e),
    target: targetOf(e),
    change,
    for: subjectUid ?? '',
    lens: lensLabel(authLens),
    when: relativeWhen(e.at, now),
    actor,
    authLens,
    subjectUid,
    event: e,
  };
  if (e.planId !== undefined) row.planId = e.planId;
  return row;
}

/** The pivot key for a row under a given group-by axis. */
function groupKeyFor(row: ActivityRow, by: ActivityGroupBy): string {
  switch (by) {
    case 'actor':
      return actorKey(row.actor);
    case 'lens':
      return row.authLens.mode === 'as'
        ? `as:${row.authLens.uid}`
        : row.authLens.mode;
    case 'subject':
      return row.subjectUid ?? '(anonymous)';
    case 'service':
      return row.service;
    case 'none':
      return '';
  }
}

/**
 * Compute the band attribution phrase: when one actor OR one subject
 * dominates the band, say so ("all by alice", "by the app"). Mixed ⇒
 * undefined (header shows just the count).
 */
function attributionFor(rows: ActivityRow[]): string | undefined {
  if (rows.length === 0) return undefined;

  // Subject dominance first ("all by alice") — it's the most pointed.
  const subjects = new Set<string>();
  for (const r of rows) if (r.subjectUid) subjects.add(r.subjectUid);
  const anonCount = rows.filter((r) => !r.subjectUid).length;
  if (subjects.size === 1 && anonCount === 0) {
    const [only] = subjects;
    return rows.length > 1 ? `all by ${only}` : `by ${only}`;
  }

  // Actor dominance ("by the app", "by agent atlas").
  const actors = new Set<string>();
  for (const r of rows) actors.add(actorKey(r.actor));
  if (actors.size === 1) {
    return `by ${actorLabel(rows[0].actor)}`;
  }
  return undefined;
}

export interface ActivitySubgroup {
  key: string;
  count: number;
  rows: ActivityRow[];
}

/**
 * A band that may carry pivot sub-groups. `subgroups` is populated only
 * when the digest was computed with `groupBy !== 'none'`; otherwise the
 * band is flat (`rows` only). `computeActivityDigest` always returns
 * bands of this shape so consumers can branch on `subgroups` presence.
 */
export interface ActivityBandWithGroups extends ActivityBand {
  /** Present only when `groupBy !== 'none'`. */
  subgroups?: ActivitySubgroup[];
}

/**
 * Fold a unified event stream into the banded activity digest. PURE —
 * no React, no clock reads except the injected `now` (defaults to
 * `Date.now()`, but pass a fixed value in tests for determinism).
 *
 * Events the digest doesn't model (listener lifecycle, snapshot
 * delivery, session boundaries, unknown kinds) are skipped — a full
 * `SandboxEvent[]` from `sandbox.history()` flows in unfiltered.
 */
export function computeActivityDigest(
  events: readonly AnyActivityEvent[],
  opts: ActivityDigestOptions & { now?: number } = {},
): ActivityDigest {
  const {
    order = 'recency',
    groupBy = 'none',
    rowsPerBand,
    now = Date.now(),
  } = opts;

  const byBand = new Map<ActivityBandKey, ActivityRow[]>();
  let deniedCount = 0;

  for (const e of events) {
    if (!isModelled(e)) continue;
    const row = toRow(e, now);
    if (row.denied) deniedCount++;
    const list = byBand.get(row.band);
    if (list) list.push(row);
    else byBand.set(row.band, [row]);
  }

  const sortRows = (rows: ActivityRow[]): ActivityRow[] =>
    rows.sort((a, b) =>
      order === 'recency' ? b.at - a.at : a.at - b.at,
    );

  const bands: ActivityBandWithGroups[] = [];
  let total = 0;

  for (const [key, allRows] of byBand) {
    sortRows(allRows);
    const count = allRows.length;
    total += count;
    const rows =
      rowsPerBand !== undefined ? allRows.slice(0, rowsPerBand) : allRows;
    if (groupBy !== 'none') {
      for (const r of rows) r.groupKey = groupKeyFor(r, groupBy);
    }
    const band: ActivityBandWithGroups = {
      key,
      label: BAND_LABEL[key],
      count,
      rows,
    };
    const attr = attributionFor(allRows);
    if (attr) band.attribution = attr;
    if (groupBy !== 'none') {
      const groups = new Map<string, ActivityRow[]>();
      for (const r of rows) {
        const gk = groupKeyFor(r, groupBy);
        const g = groups.get(gk);
        if (g) g.push(r);
        else groups.set(gk, [r]);
      }
      band.subgroups = [...groups.entries()]
        .map(([k, rs]) => ({ key: k, count: rs.length, rows: rs }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    }
    bands.push(band);
  }

  bands.sort((a, b) => BAND_RANK[a.key] - BAND_RANK[b.key]);

  const denials = sortRows((byBand.get('denied') ?? []).slice());

  return { bands, total, deniedCount, denials };
}
