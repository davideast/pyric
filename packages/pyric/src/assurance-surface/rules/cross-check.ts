/**
 * Owner inference: cross-check what the rules tie to `auth.uid` with what
 * the client writes from the signed-in user.
 *
 * - Both sides agree (the rule compares `$uid` to `auth.uid` and the client
 *   fills `$uid` from the user; the rule compares `author` and the client
 *   writes `author: user.uid`): **strong**.
 * - Only the rules say so: **tentative, rules-only** (the client never
 *   writes that field, or writes it from somewhere else).
 * - Only the code says so: **tentative, code-only**. This is how a rule
 *   that forgot its owner check (`presence/$uid` guarded by `auth != null`)
 *   still yields an owner to probe.
 *
 * No field names are special: every binding comes from a comparison in the
 * rules or an auth-sourced value in the code.
 */
import { isWriteOp } from '../code/operation-specs.js';
import type { AccessService, AccessSite } from '../code/types.js';
import { covers, parseTemplate, renderTemplate, shapeKey, type TemplateSegment } from './templates.js';
import type { OwnerBinding, OwnerCondition } from './types.js';

const WRITE_RULE_OPS = new Set(['write', 'validate', 'create', 'update', 'delete']);

/** A client-side owner fact: a path variable or a written field filled from the signed-in uid. */
interface CodeFact {
  site: AccessSite;
  kind: 'pathVar' | 'field';
  /** Path variable index, for pathVar. */
  index?: number;
  /** Field name, for field (`.` for a scalar payload). */
  field?: string;
  /** Absolute location of a field: site segments plus the field. */
  location?: TemplateSegment[];
  certainty: 'exact' | 'partial';
  id: string;
}

function isUid(auth: { source: string }[] | undefined): auth is { source: string; certainty: 'exact' | 'partial' }[] {
  return auth !== undefined && auth.some((a) => a.source === 'auth.uid');
}

/** True when the uid is the only identity the value can come from (literal fallbacks allowed). */
function isUidOnly(auth: { source: string }[] | undefined): auth is { source: string; certainty: 'exact' | 'partial' }[] {
  return isUid(auth) && auth.every((a) => a.source === 'auth.uid');
}

function uidCertainty(auth: { source: string; certainty: 'exact' | 'partial' }[]): 'exact' | 'partial' {
  return auth.find((a) => a.source === 'auth.uid')?.certainty ?? 'partial';
}

/** Owner facts from the client's write sites. */
function codeFacts(sites: AccessSite[]): CodeFact[] {
  const out: CodeFact[] = [];
  sites.forEach((site, n) => {
    if (!isWriteOp(site.op) || !site.path || site.resolution === 'unresolved') return;
    const segs = parseTemplate(site.path);
    let varPos = 0;
    segs.forEach((seg, index) => {
      if (seg.kind !== 'var') return;
      const v = site.pathVariables?.[varPos++];
      if (v && isUid(v.auth)) out.push({ site, kind: 'pathVar', index, certainty: uidCertainty(v.auth), id: `${n}:v${index}` });
    });
    const payload = site.payload;
    if (!payload) return;
    if (isUidOnly(payload.auth)) out.push({ site, kind: 'field', field: '.', location: segs, certainty: uidCertainty(payload.auth), id: `${n}:.` });
    for (const f of payload.fields) {
      // A field that is the uid or some other identity (`displayName || email || uid`) is attribution, not ownership.
      if (!isUidOnly(f.auth)) continue;
      const location = site.service === 'rtdb' ? [...segs, ...parseTemplate(f.name)] : segs;
      out.push({ site, kind: 'field', field: f.name, location, certainty: uidCertainty(f.auth), id: `${n}:f:${f.name}` });
    }
  });
  return out;
}

/** True when the rule guards writes (and so can be checked against write sites). */
function guardsWrites(c: OwnerCondition): boolean {
  return c.ops.some((op) => WRITE_RULE_OPS.has(op));
}

/** RTDB `.read`/`.write` cascade to children; `.validate` and Firestore rules apply where they are. */
function cascades(c: OwnerCondition): boolean {
  return c.service === 'rtdb' && !c.ops.every((op) => op === 'validate');
}

/** Code facts that support one rule condition, and the write sites the rule governs. */
function supportFor(c: OwnerCondition, facts: CodeFact[], sites: AccessSite[]): { support: CodeFact[]; governed: AccessSite[] } {
  const rule = parseTemplate(c.path);
  const governed = sites.filter((s) => s.service === c.service && s.path && isWriteOp(s.op) && covers(rule, parseTemplate(s.path), cascades(c)));
  const support: CodeFact[] = [];
  for (const fact of facts) {
    if (fact.site.service !== c.service) continue;
    const sitePath = parseTemplate(fact.site.path);
    if (c.kind === 'pathVar' && fact.kind === 'pathVar') {
      if (c.varIndex !== undefined && c.varIndex === fact.index && covers(rule, sitePath, true)) support.push(fact);
    } else if ((c.kind === 'storedField' || c.kind === 'incomingField') && fact.kind === 'field' && c.location) {
      if (fieldMatches(c, fact)) support.push(fact);
    } else if (c.kind === 'lookup' && fact.kind === 'pathVar') {
      const lookup = parseTemplate(c.field.split('#')[0]);
      const authIndex = lookup.findIndex((s) => s.kind === 'var' && s.name === 'auth.uid');
      if (authIndex >= 0 && authIndex === fact.index && covers(lookup, sitePath, false)) support.push(fact);
    }
  }
  return { support, governed };
}

function fieldMatches(c: OwnerCondition, fact: CodeFact): boolean {
  if (c.service === 'firestore') {
    const [docPath, field] = c.location!.split('#');
    return fact.field === field && covers(parseTemplate(docPath), parseTemplate(fact.site.path), false);
  }
  const location = parseTemplate(c.location!);
  return covers(location, fact.location!, false);
}

function depthOf(decidedAt: string, written: string[]): OwnerBinding['depth'] {
  const decided = parseTemplate(decidedAt).length;
  const writtenAt = [...new Set(written)].sort();
  return { decidedAt, writtenAt, keyedMap: writtenAt.some((w) => parseTemplate(w).length > decided) };
}

/** Infer owner bindings from rule conditions and access sites. */
export function inferOwnerBindings(conditions: OwnerCondition[], sites: AccessSite[]): OwnerBinding[] {
  const facts = codeFacts(sites);
  const used = new Set<string>();
  const byKey = new Map<string, OwnerBinding>();
  for (const c of conditions) {
    const found = supportFor(c, facts, sites);
    const support = found.support;
    const governed = guardsWrites(c) ? found.governed : [];
    for (const f of support) used.add(f.id);
    const strong = support.length > 0;
    const key = `${c.service}|${shapeKey(c.path)}|${c.kind}|${c.field}`;
    // A lookup's support is the record it reads (a membership entry), not the writes it guards.
    const writtenSites = strong && c.kind !== 'lookup' ? support.map((f) => f.site) : governed;
    const written = writtenSites.map((s) => s.path);
    const existing = byKey.get(key);
    if (existing) {
      existing.ops = [...new Set([...(existing.ops ?? []), ...c.ops])];
      existing.ruleSources = [...new Set([...(existing.ruleSources ?? []), c.source])];
      existing.required = (existing.required ?? false) || c.required;
      if (strong) {
        existing.strength = 'strong';
        existing.evidence = 'rules+code';
        existing.codeSources = [...new Set([...(existing.codeSources ?? []), ...support.map((f) => f.site.source)])];
      }
      existing.depth = depthOf(existing.depth.decidedAt, [...existing.depth.writtenAt, ...written]);
      continue;
    }
    const binding: OwnerBinding = {
      path: c.path,
      kind: c.kind,
      field: c.field,
      strength: strong ? 'strong' : 'tentative',
      service: c.service,
      evidence: strong ? 'rules+code' : 'rules-only',
      relation: c.relation,
      ops: [...c.ops],
      required: c.required,
      depth: depthOf(c.path, written),
      ruleSources: [c.source],
      evidenceText: c.expression,
    };
    if (strong) binding.codeSources = [...new Set(support.map((f) => f.site.source))];
    byKey.set(key, binding);
  }
  for (const b of codeOnlyBindings(facts.filter((f) => !used.has(f.id)))) {
    const key = `${b.service}|${shapeKey(b.path)}|${b.kind}|${b.field}`;
    if (!byKey.has(key)) byKey.set(key, b);
  }
  return [...byKey.values()].sort((a, b) => (a.path === b.path ? a.kind.localeCompare(b.kind) : a.path.localeCompare(b.path)));
}

/** Tentative bindings for owner facts no rule speaks to. */
function codeOnlyBindings(facts: CodeFact[]): OwnerBinding[] {
  const byKey = new Map<string, OwnerBinding>();
  for (const f of facts) {
    const service: AccessService = f.site.service;
    const segs = parseTemplate(f.site.path);
    let kind: OwnerBinding['kind'];
    let field: string;
    let path = f.site.path;
    if (f.kind === 'pathVar') {
      kind = 'pathVar';
      const seg = segs[f.index!];
      field = renderTemplate([seg], service);
      path = renderTemplate(segs, service);
    } else {
      kind = 'incomingField';
      field = f.field!;
    }
    const key = `${service}|${shapeKey(path)}|${kind}|${kind === 'pathVar' ? f.index : field}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.codeSources = [...new Set([...(existing.codeSources ?? []), f.site.source])];
      continue;
    }
    let evidenceText = `client writes '${field}' from the signed-in uid (${f.certainty}); no rule compares it to auth.uid`;
    if (kind === 'pathVar') {
      evidenceText = `client fills ${field} from the signed-in uid (${f.certainty}); no rule compares it to auth.uid`;
    }
    byKey.set(key, {
      path,
      kind,
      field,
      strength: 'tentative',
      service,
      evidence: 'code-only',
      depth: depthOf(path, [f.site.path]),
      codeSources: [f.site.source],
      evidenceText,
    });
  }
  return [...byKey.values()];
}
