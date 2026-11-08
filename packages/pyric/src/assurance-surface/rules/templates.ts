/**
 * Path templates for matching rule paths against client access-site
 * paths. Variable names never matter: a rule variable matches any segment,
 * a Firestore recursive wildcard matches any remainder, and literals must
 * be equal. A client variable does not match a rule literal: the client
 * can't be shown to write there.
 */
import type { AccessService } from '../code/types.js';

export type TemplateSegment =
  | { kind: 'lit'; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'rest'; name: string };

/** Parse `a/$b/{c}/{d=**}` (either service's syntax) into segments. */
export function parseTemplate(path: string): TemplateSegment[] {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s): TemplateSegment => {
      const rest = /^\{(.+)=\*\*\}$/.exec(s);
      if (rest) return { kind: 'rest', name: rest[1] };
      const brace = /^\{(.+)\}$/.exec(s);
      if (brace) return { kind: 'var', name: brace[1] };
      if (s.startsWith('$')) return { kind: 'var', name: s.slice(1) };
      return { kind: 'lit', text: s };
    });
}

/**
 * True when the rule template covers the site template. `prefix` lets the
 * site be deeper than the rule (RTDB `.read`/`.write` cascade to children).
 */
export function covers(rule: TemplateSegment[], site: TemplateSegment[], prefix: boolean): boolean {
  for (let i = 0; i < rule.length; i++) {
    const r = rule[i];
    if (r.kind === 'rest') return true;
    const s = site[i];
    if (!s) return false;
    if (r.kind === 'lit' && (s.kind !== 'lit' || s.text !== r.text)) return false;
  }
  return prefix ? site.length >= rule.length : site.length === rule.length;
}

/** Render a template for one service. */
export function renderTemplate(segments: TemplateSegment[], service: AccessService): string {
  return segments
    .map((s) => {
      if (s.kind === 'lit') return s.text;
      if (s.kind === 'rest') return `{${s.name}=**}`;
      return service === 'firestore' ? `{${s.name}}` : `$${s.name}`;
    })
    .join('/');
}

/** A shape key with variable names erased, for deduping. */
export function shapeKey(path: string): string {
  return parseTemplate(path)
    .map((s) => {
      if (s.kind === 'lit') return s.text;
      if (s.kind === 'rest') return '**';
      return '*';
    })
    .join('/');
}
