/**
 * Concrete values for probes: paths with their variables filled for an
 * actor, and payloads synthesized from the client's own write shape
 * (literals kept, auth-sourced fields set from the actor, SDK sentinels
 * kept as sentinels).
 */
import type { AccessService, AccessSite, PayloadField, PayloadShape } from '../code/types.js';
import { parseResourcePattern } from '../../sandbox/internal/index.js';
import { effectiveFirestoreDocs, effectiveRtdbTree } from './state.js';
import type { ProbeActor, Sentinel } from './types.js';
import type { WorldState } from './world.js';

/** Overrides when building a path or payload. */
export interface FillOptions {
  otherUid?: string;
  state?: WorldState;
  /** Actor whose identity fills uid-derived path variables (defaults to the payload actor). */
  keyActor?: ProbeActor;
  /** Suffix for non-auth variables, to address a different record (`-2`). */
  variant?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when a path variable is filled from the signed-in uid. */
export function isUidVariable(site: AccessSite, varPosition: number): boolean {
  return site.pathVariables?.[varPosition]?.auth?.some((a) => a.source === 'auth.uid') ?? false;
}

/**
 * Concrete path for a site's template. Uid-derived variables use the key
 * actor's uid (through their pattern, `{auth.uid}:{*}`); other variables
 * get a fixed value per name, so two probes on one record agree.
 */
export function concretePath(site: AccessSite, actor: ProbeActor, options: FillOptions = {}): string {
  const keyActor = options.keyActor ?? actor;
  let otherUid = options.otherUid;
  if (!otherUid) {
    otherUid = keyActor.uid === 'probe-owner' ? 'probe-peer' : 'probe-owner';
  }
  let varPos = 0;
  let uidVarsSeen = 0;
  const usedUids = new Set<string>();
  const outSegments: string[] = [];

  const parsed = parseResourcePattern(site.service, site.path).segments;

  let tempVarPos = 0;
  let lastVarIndex = -1;
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].kind === 'var') {
      const v = site.pathVariables?.[tempVarPos++];
      if (!v?.auth?.some((a) => a.source === 'auth.uid')) {
        lastVarIndex = i;
      }
    }
  }

  let fsKeys: string[] = [];
  if (options.state && site.service === 'firestore') {
    fsKeys = Object.keys(effectiveFirestoreDocs(options.state));
  }
  let currentState: unknown = undefined;
  if (options.state && site.service === 'rtdb') {
    currentState = effectiveRtdbTree(options.state);
  }

  for (let i = 0; i < parsed.length; i++) {
    const seg = parsed[i];
    let val = '';
    if (seg.kind === 'lit') {
      val = seg.text;
    } else if (seg.kind === 'rest') {
      val = `r-${seg.name}`;
    } else {
      const v = site.pathVariables?.[varPos++];
      if (v?.auth?.some((a) => a.source === 'auth.uid')) {
        uidVarsSeen++;
        const useUid = uidVarsSeen === 1 ? keyActor.uid : otherUid;
        const replaceWildcard = usedUids.has(useUid) ? 'x2' : 'x1';
        usedUids.add(useUid);
        const pattern = v.pattern ?? '{auth.uid}';
        val = pattern.replace(/\{auth\.uid\}/g, useUid).replace(/\{\*\}/g, replaceWildcard);
      } else {
        let seedKey: string | undefined;
        const isLeaf = i === parsed.length - 1;

        if (options.state && site.service === 'firestore') {
          let prefix = '';
          if (outSegments.length > 0) prefix = `${outSegments.join('/')}/`;
          for (const rawKey of fsKeys) {
            const k = rawKey.replace(/^\/+|\/+$/g, '');
            if (k.startsWith(prefix)) {
              const remainder = k.slice(prefix.length).split('/');
              if (remainder.length > 0 && remainder[0]!.length > 0) {
                seedKey = remainder[0];
                break;
              }
            }
          }
        } else if (isPlainRecord(currentState)) {
          const stateObj = currentState;
          const keys = Object.keys(stateObj);
          if (keys.length > 0) {
            let best = keys.find((k) => k !== '.sv' && k !== '.value');
            const nextSeg = parsed[i + 1];
            if (best && nextSeg?.kind === 'lit') {
              const nextLit = nextSeg.text;
              const withNext = keys.find((k) => {
                if (k === '.sv' || k === '.value') return false;
                const child = stateObj[k];
                return isPlainRecord(child) && Object.hasOwn(child, nextLit);
              });
              if (withNext) best = withNext;
            }
            seedKey = best ?? keys[0];
          }
        }

        if (seedKey && !isLeaf) {
          val = seedKey;
        } else {
          let suffix = '';
          if (i === lastVarIndex && options.variant) suffix = options.variant;
          val = `${seg.prefix ?? ''}v-${seg.name}${suffix}${seg.suffix ?? ''}`;
        }
      }
    }
    outSegments.push(val);
    if (site.service === 'rtdb' && isPlainRecord(currentState) && Object.hasOwn(currentState, val)) {
      currentState = currentState[val];
    } else {
      currentState = undefined;
    }
  }
  return outSegments.join('/');
}

/** Concrete path for a template alone (rule templates), with named variables filled from a map. */
export function fillTemplate(
  template: string,
  values: Record<string, string>,
  fallback: (name: string) => string,
  service: AccessService = 'firestore',
): string {
  return parseResourcePattern(service, template)
    .segments.map((seg) => {
      if (seg.kind === 'lit') return seg.text;
      let bound = fallback(seg.name);
      if (Object.hasOwn(values, seg.name)) {
        bound = values[seg.name]!;
      }
      if (seg.kind === 'var') {
        return `${seg.prefix ?? ''}${bound}${seg.suffix ?? ''}`;
      }
      return bound;
    })
    .join('/');
}

function sentinel(kind: Sentinel['__sentinel'], by?: number): Sentinel {
  return by === undefined ? { __sentinel: kind } : { __sentinel: kind, by };
}

/** The value of one field for an actor. */
export function fieldValue(f: Pick<PayloadField, 'name' | 'kind' | 'auth' | 'literal'>, actor: ProbeActor): unknown {
  const auth = f.auth?.[0]?.source;
  if (auth === 'auth.uid') return actor.uid;
  if (auth === 'auth.displayName') return actor.displayName;
  if (auth === 'auth.email') return actor.email;
  if (f.literal !== undefined) return f.literal;
  const leaf = f.name.split(/[/.]/).pop() ?? 'v';
  switch (f.kind) {
    case 'string':
      return `s-${leaf}`;
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'object':
      return {};
    case 'array':
      return [`s-${leaf}`];
    case 'serverTimestamp':
      return sentinel('serverTimestamp');
    case 'increment':
      return sentinel('increment', 1);
    case 'arrayUnion':
      return sentinel('arrayUnion');
    case 'arrayRemove':
      return sentinel('arrayRemove');
    case 'deleteField':
      return sentinel('deleteField');
    default:
      return `s-${leaf}`;
  }
}

/**
 * A payload for an actor from the client's write shape. Optional fields
 * are left out; nested fields (`speaker/uid`, `speaker.uid`) build nested
 * objects. `overrides` replaces fields by name.
 */
export function concretePayload(shape: PayloadShape | undefined, actor: ProbeActor, separator: string, overrides: Record<string, unknown> = {}): unknown {
  if (!shape) return null;
  if (shape.kind !== 'object') {
    if (Object.hasOwn(overrides, '.')) return overrides['.'];
    return fieldValue({ name: 'value', kind: shape.kind, auth: shape.auth, literal: shape.literal }, actor);
  }
  const out: Record<string, unknown> = {};
  const fields = shape.fields.filter((f) => !f.optional);
  // Shallow fields first, so nested ones land inside their parent object.
  for (const f of [...fields].sort((a, b) => depth(a.name, separator) - depth(b.name, separator))) {
    const value = Object.hasOwn(overrides, f.name) ? overrides[f.name] : fieldValue(f, actor);
    setPath(out, f.name.split(separator), value);
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (name !== '.' && !fields.some((f) => f.name === name)) setPath(out, name.split(separator), value);
  }
  return pruneEmpty(out);
}

function depth(name: string, sep: string): number {
  return name.split(sep).length;
}

function setPath(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let cur = obj;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) {
      // A nested field overrides a synthesized empty parent, not a real value.
      const existing = cur[k];
      if (existing && typeof existing === 'object' && !isSentinel(existing) && value && typeof value === 'object') return;
      cur[k] = value;
      return;
    }
    const next = cur[k];
    if (!next || typeof next !== 'object' || isSentinel(next) || Array.isArray(next)) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  });
}

/** Empty objects can't be written to RTDB (they are deletes); give them one field. */
function pruneEmpty(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v) || isSentinel(v)) return v;
  const entries = Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, pruneEmpty(x)] as const);
  if (entries.length === 0) return { v: 's-v' };
  return Object.fromEntries(entries);
}

export function isSentinel(v: unknown): v is Sentinel {
  return typeof v === 'object' && v !== null && '__sentinel' in v;
}

/** Field names in a payload shape whose value comes from the signed-in uid alone. */
export function uidFields(shape: PayloadShape | undefined): string[] {
  if (!shape) return [];
  return shape.fields.filter((f) => f.auth?.length && f.auth.every((a) => a.source === 'auth.uid')).map((f) => f.name);
}

/** Field names carrying a display name or email (attribution). */
export function attributionFields(shape: PayloadShape | undefined): string[] {
  if (!shape) return [];
  return shape.fields.filter((f) => f.auth?.some((a) => a.source === 'auth.displayName' || a.source === 'auth.email')).map((f) => f.name);
}

const SCALAR_CONCRETE_KINDS = new Set<PayloadField['kind']>(['number', 'boolean', 'null', 'serverTimestamp', 'increment']);

function isDeterminedScalar(f: Pick<PayloadField, 'kind' | 'literal' | 'auth'>): boolean {
  if (f.literal !== undefined) return true;
  if ((f.auth?.length ?? 0) > 0) return true;
  return SCALAR_CONCRETE_KINDS.has(f.kind);
}

function hasConcreteChildField(fields: PayloadField[], parentName: string): boolean {
  const dotPrefix = `${parentName}.`;
  const slashPrefix = `${parentName}/`;
  return fields.some((child) => !child.optional && (child.name.startsWith(dotPrefix) || child.name.startsWith(slashPrefix)));
}

/** True when every field of a payload is determined (literal, auth-sourced, or a concrete kind). */
export function isConcretePayload(shape: PayloadShape | undefined): boolean {
  if (!shape) return true;
  if (shape.open) return false;
  if (shape.kind !== 'object') {
    return isDeterminedScalar({ kind: shape.kind, literal: shape.literal, auth: shape.auth });
  }
  return shape.fields.every((f) => {
    if (f.optional) return f.kind !== 'unknown';
    if (f.kind === 'object') return hasConcreteChildField(shape.fields, f.name);
    return isDeterminedScalar(f);
  });
}
