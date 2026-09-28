/**
 * The Rules Test API compile-limit probes in
 * `linter/fixtures/compile-limits/captures.json`, each with the ruleset the
 * capture submitted, rebuilt by the capture's own generators.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  callChain,
  probeBlock,
  wrap,
  type ProbeRecord,
  type Service,
  type Shape,
} from '../../../conformance/src/capture-rules-compile-limits.ts';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'linter', 'fixtures', 'compile-limits', 'captures.json');

export interface CompileLimitProbe {
  service: Service;
  shape: Shape;
  n: number;
  range?: [number, number];
  compiles: boolean;
  /** The ruleset source the capture submitted. */
  source: string;
  /** Production's ERROR-severity messages, in order. */
  errors: string[];
  /**
   * The errors the compile-limits module reports: all of them, except after
   * a slash that starts a path, where production's parser recovery adds
   * issues that depend on the next token and only the first is modeled.
   */
  modeledErrors: string[];
  /** Where production reports each ERROR, as [line, column]; absent when it gives no position. */
  errorPositions: ([number, number] | undefined)[];
  /** A readable label for a test name. */
  label: string;
}

/** Every probe in the capture, with its ruleset. */
export function compileLimitProbes(): CompileLimitProbe[] {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { probes: ProbeRecord[] };
  return fixture.probes.map((p) => {
    const errors = p.issues.filter((i) => i.severity === 'ERROR').map((i) => i.description);
    return {
      service: p.service,
      shape: p.shape,
      n: p.n,
      ...(p.range ? { range: p.range } : {}),
      compiles: p.compiles,
      source: wrap(p.service, p.range ? combinedCallDepths(p.range) : probeBlock(p.shape, p.n)),
      errors,
      modeledErrors: p.shape === 'slash-divisor' ? errors.slice(0, 1) : errors,
      errorPositions: p.issues
        .filter((i) => i.severity === 'ERROR')
        .map((i) => (i.line === undefined || i.column === undefined ? undefined : [i.line, i.column])),
      label: `${p.service} ${p.shape} ${p.range ? `${p.range[0]}..${p.range[1]}` : `n=${p.n}`}`,
    };
  });
}

/** The capture's combined call-depth probe: one match block per chain length in the range. */
function combinedCallDepths([lo, hi]: [number, number]): string {
  const blocks: string[] = [];
  for (let n = lo; n <= hi; n++) {
    blocks.push(`    match /p${n}/{d} {\n${callChain(`c${n}_`, n)}\n      allow read: if c${n}_1();\n    }`);
  }
  return blocks.join('\n');
}
