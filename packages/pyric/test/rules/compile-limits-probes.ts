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
  /** A readable label for a test name. */
  label: string;
}

/**
 * Deepest parenthesis nesting a probe may have to be replayed. The parser
 * descends once per nested group, and around 200 to 300 groups it exhausts
 * the host stack, at a depth that varies with the runtime's stack state, so
 * the probe of 200 groups is left out. The boundary probes (97 to 130 groups)
 * stay well inside it.
 */
const PARSER_NESTING_CEILING = 150;

/** Every probe in the capture that the parser can replay, with its ruleset. */
export function compileLimitProbes(): CompileLimitProbe[] {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { probes: ProbeRecord[] };
  return fixture.probes.filter((p) => !(p.shape === 'paren-nesting' && p.n > PARSER_NESTING_CEILING)).map((p) => ({
    service: p.service,
    shape: p.shape,
    n: p.n,
    ...(p.range ? { range: p.range } : {}),
    compiles: p.compiles,
    source: wrap(p.service, p.range ? combinedCallDepths(p.range) : probeBlock(p.shape, p.n)),
    errors: p.issues.filter((i) => i.severity === 'ERROR').map((i) => i.description),
    label: `${p.service} ${p.shape} ${p.range ? `${p.range[0]}..${p.range[1]}` : `n=${p.n}`}`,
  }));
}

/** The capture's combined call-depth probe: one match block per chain length in the range. */
function combinedCallDepths([lo, hi]: [number, number]): string {
  const blocks: string[] = [];
  for (let n = lo; n <= hi; n++) {
    blocks.push(`    match /p${n}/{d} {\n${callChain(`c${n}_`, n)}\n      allow read: if c${n}_1();\n    }`);
  }
  return blocks.join('\n');
}
