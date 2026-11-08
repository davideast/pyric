/**
 * Existing data a probe can use: records already present in a seed (so an
 * attack can target another user's real record) and the display names
 * users already sign their records with.
 */
import { isWriteOp } from '../code/operation-specs.js';
import type { AccessSite, PayloadField } from '../code/types.js';
import { covers, parseTemplate, shapeKey } from '../rules/templates.js';
import { attributionFields, uidFields } from './fixtures.js';
import type { WorldState } from './world.js';

export interface StateRecord {
  path: string;
  data: unknown;
}

/** Records in the seed whose path matches a template (variables match any key). */
export function recordsAt(service: 'firestore' | 'rtdb', template: string, state: WorldState | undefined): StateRecord[] {
  if (!state) return [];
  const t = parseTemplate(template);
  if (service === 'firestore') {
    const out: StateRecord[] = [];
    for (const [path, data] of Object.entries(state.firestore ?? {})) {
      const segs = path.replace(/^\/+/, '').split('/');
      if (segs.length !== t.length) continue;
      if (t.every((s, i) => s.kind !== 'lit' || s.text === segs[i])) out.push({ path: segs.join('/'), data });
    }
    return out;
  }
  const out: StateRecord[] = [];
  const walk = (node: unknown, depth: number, path: string[]): void => {
    if (depth === t.length) {
      out.push({ path: path.join('/'), data: node });
      return;
    }
    if (!node || typeof node !== 'object') return;
    const seg = t[depth];
    const obj = node as Record<string, unknown>;
    if (seg.kind === 'lit') {
      if (Object.hasOwn(obj, seg.text)) walk(obj[seg.text], depth + 1, [...path, seg.text]);
      return;
    }
    for (const [k, v] of Object.entries(obj)) walk(v, depth + 1, [...path, k]);
  };
  walk(state.rtdb, 0, []);
  return out;
}

/** A field of a record, by a `/`- or `.`-separated name. */
export function fieldOf(data: unknown, name: string, separator: string): unknown {
  let cur = data;
  for (const k of name.split(separator)) {
    if (!cur || typeof cur !== 'object') return undefined;
    if (!Object.hasOwn(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * Display names users sign records with, read from records that carry both
 * a uid field and an attribution field (`{ author: 'alice', authorName: 'Alice Chen' }`).
 */
export function namesFromState(sites: AccessSite[], state: WorldState | undefined, uids: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  // Names shown anywhere in attribution fields, and records keyed by a user's uid that show one of them.
  const shown = new Set<string>();
  for (const site of sites) {
    const sep = site.service === 'firestore' ? '.' : '/';
    for (const name of attributionFields(site.payload)) {
      for (const r of recordsAt(site.service, site.path, state)) {
        const v = fieldOf(r.data, name, sep);
        if (typeof v === 'string') shown.add(v);
      }
    }
  }
  for (const site of sites) {
    if (!(site.pathVariables ?? []).some((v) => v.auth?.some((a) => a.source === 'auth.uid'))) continue;
    for (const r of recordsAt(site.service, site.path, state)) {
      const key = uids.find((u) => r.path.split('/').includes(u));
      if (!key || out.has(key) || !r.data || typeof r.data !== 'object') continue;
      const named = Object.values(r.data as Record<string, unknown>).find((v) => typeof v === 'string' && shown.has(v));
      if (typeof named === 'string') out.set(key, named);
    }
  }
  for (const site of sites) {
    const owners = uidFields(site.payload);
    const names = attributionFields(site.payload).filter((n) => !owners.includes(n));
    if (owners.length === 0 || names.length === 0) continue;
    const sep = site.service === 'firestore' ? '.' : '/';
    for (const r of recordsAt(site.service, site.path, state)) {
      const uid = fieldOf(r.data, owners[0], sep);
      const name = fieldOf(r.data, names[0], sep);
      if (typeof uid === 'string' && typeof name === 'string' && !out.has(uid)) out.set(uid, name);
    }
  }
  return out;
}

/** Attribution values already present at a template, for a spoof that shows another user's real name. */
export function attributionValuesAt(site: AccessSite, field: string, state: WorldState | undefined): string[] {
  const sep = site.service === 'firestore' ? '.' : '/';
  return recordsAt(site.service, site.path, state)
    .map((r) => fieldOf(r.data, field, sep))
    .filter((v): v is string => typeof v === 'string');
}

function kindOf(v: unknown): import('../code/types.js').PayloadField['kind'] {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'object') return 'object';
  return 'unknown';
}

/**
 * Write sites read off existing Firestore documents, for an app whose code
 * isn't available: each document's path becomes a template (a document id
 * that is a known user's uid becomes a uid-keyed variable), and each field a
 * payload field (a value that is a known user's uid is marked as coming from
 * the signed-in user). Strings keep their values, so a written shape matches
 * what rules validate.
 */
export function sitesFromState(state: WorldState | undefined, uids: string[]): AccessSite[] {
  const byTemplate = new Map<string, { site: AccessSite; docs: number; fieldValues: Map<string, Set<unknown>> }>();
  const users = new Set(uids);
  for (const [rawPath, data] of Object.entries(state?.firestore ?? {})) {
    const segs = rawPath.replace(/^\/+/, '').split('/');
    if (segs.length % 2 !== 0 || !data || typeof data !== 'object') continue;
    const vars: NonNullable<AccessSite['pathVariables']> = [];
    const template = segs
      .map((s, i) => {
        if (i % 2 === 0) return s;
        const name = users.has(s) ? 'uid' : `${segs[i - 1].replace(/s$/, '')}Id`;
        vars.push(users.has(s) ? { name, auth: [{ source: 'auth.uid', certainty: 'exact' }] } : { name });
        return `{${name}}`;
      })
      .join('/');
    
    let entry = byTemplate.get(template);
    if (!entry) {
      entry = {
        site: {
          path: template,
          service: 'firestore',
          op: 'setDoc',
          source: `seed:${rawPath}`,
          resolution: 'resolved',
          pathVariables: vars,
          payload: { kind: 'object', fields: [], open: false },
        },
        docs: 0,
        fieldValues: new Map()
      };
      byTemplate.set(template, entry);
    }
    
    entry.docs++;
    for (const [name, v] of Object.entries(data as Record<string, unknown>)) {
      if (!entry.site.payload!.fields.some(f => f.name === name)) {
         const f: import('../code/types.js').PayloadField = { name, kind: kindOf(v) };
         if (typeof v === 'string' && users.has(v)) f.auth = [{ source: 'auth.uid', certainty: 'exact' }];
         entry.site.payload!.fields.push(f);
      }
      if (!entry.fieldValues.has(name)) entry.fieldValues.set(name, new Set());
      const setV = entry.fieldValues.get(name)!;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
         setV.add(v);
      } else {
         setV.add(Symbol('complex'));
      }
    }
  }
  
  for (const entry of byTemplate.values()) {
     for (const f of entry.site.payload!.fields) {
        const vals = entry.fieldValues.get(f.name);
        if (entry.docs > 1 && vals && vals.size === 1) {
           const val = [...vals][0];
           if (typeof val !== 'symbol') f.literal = val as string | number | boolean | null;
        } else {
           f.literal = undefined;
        }
     }
  }
  return [...byTemplate.values()].map(e => e.site);
}

/**
 * Seed-derived RTDB write sites for client-read-only collections that hold
 * user-attributed item records in `state.rtdb` (e.g. server-written logs or
 * event streams read by the client). Returns nothing when `state?.rtdb` is
 * absent or when no seeded item under `${s.path}/$itemId` carries a known uid.
 */
export function rtdbReadOnlySitesFromState(sites: AccessSite[], state: WorldState | undefined, uids: string[]): AccessSite[] {
  if (!state?.rtdb || uids.length === 0) return [];
  const users = new Set(uids);
  const out: AccessSite[] = [];
  const seen = new Set<string>();

  for (const s of sites) {
    if (s.service !== 'rtdb' || (s.op !== 'get' && s.op !== 'query') || s.resolution === 'unresolved') continue;
    if (!s.path || s.path.includes('=**')) continue;
    const readTemplate = parseTemplate(s.path);
    const hasClientWrite = sites.some(
      (w) =>
        w.service === 'rtdb' &&
        isWriteOp(w.op) &&
        w.resolution !== 'unresolved' &&
        Boolean(w.path) &&
        covers(readTemplate, parseTemplate(w.path), true),
    );
    if (hasClientWrite) continue;

    const itemTemplate = `${s.path}/$itemId`;
    const key = shapeKey(itemTemplate);
    if (seen.has(key)) continue;

    const records = recordsAt('rtdb', itemTemplate, state).filter(
      (r): r is { path: string; data: Record<string, unknown> } =>
        Boolean(r.data) && typeof r.data === 'object' && !Array.isArray(r.data),
    );
    if (records.length === 0) continue;
    const hasUidField = records.some((r) => Object.values(r.data).some((v) => typeof v === 'string' && users.has(v)));
    if (!hasUidField) continue;

    seen.add(key);
    const fields: PayloadField[] = [];
    const fieldValues = new Map<string, Set<unknown>>();
    const fieldCounts = new Map<string, number>();

    for (const r of records) {
      for (const [name, v] of Object.entries(r.data)) {
        fieldCounts.set(name, (fieldCounts.get(name) ?? 0) + 1);
        let existing = fields.find((f) => f.name === name);
        if (!existing) {
          existing = { name, kind: kindOf(v) };
          if (typeof v === 'string' && users.has(v)) existing.auth = [{ source: 'auth.uid', certainty: 'exact' }];
          fields.push(existing);
        } else if (typeof v === 'string' && users.has(v) && !existing.auth) {
          existing.auth = [{ source: 'auth.uid', certainty: 'exact' }];
        }
        if (!fieldValues.has(name)) fieldValues.set(name, new Set());
        const setV = fieldValues.get(name)!;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
          setV.add(v);
        } else {
          setV.add(Symbol('complex'));
        }
      }
    }

    for (const f of fields) {
      if ((fieldCounts.get(f.name) ?? 0) < records.length) f.optional = true;
      const vals = fieldValues.get(f.name);
      if (records.length > 1 && vals && vals.size === 1 && !f.auth?.length) {
        const val = [...vals][0];
        if (typeof val !== 'symbol') f.literal = val as string | number | boolean | null;
      }
    }

    out.push({
      path: itemTemplate,
      service: 'rtdb',
      op: 'set',
      source: `seed:${records[0].path}`,
      resolution: 'resolved',
      pathVariables: [...(s.pathVariables ?? []), { name: 'itemId' }],
      payload: { kind: 'object', fields, open: false },
    });
  }

  return out;
}
