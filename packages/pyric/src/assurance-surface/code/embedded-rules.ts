/**
 * Finds security rules an app installs from code: Pyric's in-page sandbox
 * (`setRules(sandbox, rules)` from `pyric/sandbox/firestore` or
 * `pyric/sandbox/database`) and `@firebase/rules-unit-testing`'s
 * `initializeTestEnvironment({ firestore: { rules }, database: { rules } })`.
 * The rules argument is evaluated like any other value, so a template
 * literal, a constant or an object literal all work.
 */
import ts from 'typescript';
import type { AssuranceService } from '../../sandbox/internal/resource-pattern.js';
import type { Evaluator } from './evaluator.js';
import { posixRelative } from './posix-path.js';
import { alternatives, literalText, type AVal } from './values.js';

/** Rules found in code. */
export interface EmbeddedRules {
  service: AssuranceService;
  /** `file:line` of the call that installs them. */
  source: string;
  /** Firestore/Storage rules text, or the RTDB rules object. */
  rules: string | Record<string, unknown>;
}

/** Scan files for calls that install rules, and evaluate their rules argument. */
export function findEmbeddedRules(ev: Evaluator, files: readonly ts.SourceFile[], root: string): EmbeddedRules[] {
  const out: EmbeddedRules[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) inspectCall(ev, n, root, out);
    ts.forEachChild(n, visit);
  };
  for (const sf of files) visit(sf);
  return out;
}

function inspectCall(ev: Evaluator, call: ts.CallExpression, root: string, out: EmbeddedRules[]): void {
  const callee = ev.force(ev.eval(call.expression));
  if (callee.k !== 'api') return;
  const source = sourceOf(call, root);
  if (
    callee.name === 'setRules'
    && (callee.module === 'sandbox-firestore'
      || callee.module === 'sandbox-rtdb'
      || callee.module === 'sandbox-storage')
  ) {
    const arg = call.arguments[1];
    if (!arg) return;
    let service: AssuranceService = 'rtdb';
    if (callee.module === 'sandbox-firestore') service = 'firestore';
    else if (callee.module === 'sandbox-storage') service = 'storage';
    const value = toRules(ev, ev.eval(arg), service);
    if (value !== undefined) out.push({ service, source, rules: value });
    return;
  }
  if (callee.module === 'rules-testing' && callee.name === 'initializeTestEnvironment' && call.arguments[0]) {
    const config = ev.force(ev.eval(call.arguments[0]));
    if (config.k !== 'obj') return;
    for (const [key, service] of [
      ['firestore', 'firestore'],
      ['database', 'rtdb'],
      ['storage', 'storage'],
    ] as const) {
      const section = config.props.get(key);
      const forced = section ? ev.force(section) : undefined;
      const rules = forced?.k === 'obj' ? forced.props.get('rules') : undefined;
      const value = rules ? toRules(ev, rules, service) : undefined;
      if (value !== undefined) out.push({ service, source, rules: value });
    }
  }
}

function sourceOf(node: ts.Node, root: string): string {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  return `${posixRelative(root, sf.fileName)}:${line + 1}`;
}

/** Firestore and Storage rules must be a literal string; RTDB rules a literal object or a JSON string. */
function toRules(ev: Evaluator, v: AVal, service: AssuranceService): string | Record<string, unknown> | undefined {
  for (const alt of alternatives(ev.force(v))) {
    const text = literalText(alt);
    if (text !== null) {
      if (service === 'firestore' || service === 'storage') return text;
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    if (service === 'rtdb' && alt.k === 'obj') {
      const json = toJson(ev, alt);
      if (json && typeof json === 'object' && !Array.isArray(json)) return json as Record<string, unknown>;
    }
  }
  return undefined;
}

/** A literal abstract value as JSON, or undefined when any part isn't literal. */
function toJson(ev: Evaluator, v: AVal): unknown {
  const f = ev.force(v);
  switch (f.k) {
    case 'str':
      return literalText(f) ?? undefined;
    case 'num':
      return f.value;
    case 'bool':
      return f.value;
    case 'null':
      return null;
    case 'arr': {
      const items = f.items.map((i) => toJson(ev, i));
      return items.some((i) => i === undefined) ? undefined : items;
    }
    case 'obj': {
      if (f.open || f.computed.length > 0) return undefined;
      const out: Record<string, unknown> = {};
      for (const [k, val] of f.props) {
        const j = toJson(ev, val);
        if (j === undefined) return undefined;
        Object.defineProperty(out, k, {
          value: j,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    default:
      return undefined;
  }
}
