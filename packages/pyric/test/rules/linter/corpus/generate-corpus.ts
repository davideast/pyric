/**
 * Linter test corpus generator.
 *
 * Produces rules files at various complexity levels with known compile/runtime
 * outcomes. Each file is a test fixture for the linter — the linter should
 * correctly predict the outcome.
 *
 * Run: bun test/rules/linter/corpus/generate-corpus.ts
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

interface CorpusEntry {
  filename: string;
  description: string;
  compiles: boolean;
  runtime: 'pass' | 'partial' | 'fail' | 'untested';
  failureReason: string;
  lintRules: string[];    // which lint rules should fire
  source: string;
  metrics: {
    sizeBytes: number;
    lines: number;
    functions: number;
    maxLetsPerFunction: number;
    allowRules: number;
    sharedGates: boolean;
    estimatedMaxExprPerRule: number;
  };
}

const corpus: CorpusEntry[] = [];

function save(entry: CorpusEntry) {
  writeFileSync(join(OUT, entry.filename), entry.source);
  corpus.push({ ...entry, source: `[file: ${entry.filename}]` });
}

// ═══ Helper: generate N let bindings in a function ═══
function fnWithLets(name: string, n: number): string {
  const lets = Array.from({ length: n }, (_, i) =>
    `        let v${i} = request.resource.data.f${i};`
  ).join('\n');
  const ret = Array.from({ length: n }, (_, i) => `v${i} != ''`).join(' && ');
  return `      function ${name}() {\n${lets}\n        return ${ret};\n      }`;
}

// ═══ Helper: generate N functions ═══
function nFunctions(count: number): string {
  return Array.from({ length: count }, (_, i) =>
    `      function fn${i}() { return request.resource.data.f${i} != ''; }`
  ).join('\n');
}

// ═══ Helper: generate allow rules with shared or unique gates ═══
function allowRulesSharedGate(count: number): string {
  return Array.from({ length: count }, (_, i) =>
    `      allow update: if request.resource.data.moveType == 'normal'\n            && fn${i}();`
  ).join('\n');
}

function allowRulesUniqueGate(count: number): string {
  return Array.from({ length: count }, (_, i) =>
    `      allow update: if request.resource.data.moveType == 'type${i}'\n            && fn${i}();`
  ).join('\n');
}

function wrap(body: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /test/{docId} {
${body}
    }
  }
}`;
}

// ═══════════════════════════════════════════════════════════════
// CORPUS: Known-good rules (should compile and work)
// ═══════════════════════════════════════════════════════════════

// 1. Minimal valid rules
const minimal = wrap(`      allow read: if request.auth != null;
      allow write: if request.auth != null;`);
save({
  filename: '01-minimal.rules',
  description: 'Minimal valid rules — baseline',
  compiles: true, runtime: 'pass', failureReason: '',
  lintRules: [],
  source: minimal,
  metrics: { sizeBytes: minimal.length, lines: minimal.split('\n').length, functions: 0, maxLetsPerFunction: 0, allowRules: 2, sharedGates: false, estimatedMaxExprPerRule: 1 },
});

// 2. 10 let bindings (at the limit)
const letsOk = wrap(`${fnWithLets('check10', 10)}
      allow update: if check10();`);
save({
  filename: '02-lets-10-ok.rules',
  description: '10 let bindings in one function — at the limit, should compile',
  compiles: true, runtime: 'pass', failureReason: '',
  lintRules: [],
  source: letsOk,
  metrics: { sizeBytes: letsOk.length, lines: letsOk.split('\n').length, functions: 1, maxLetsPerFunction: 10, allowRules: 1, sharedGates: false, estimatedMaxExprPerRule: 10 },
});

// 3. Small function set (10 functions)
const fns10 = wrap(`${nFunctions(10)}
${allowRulesUniqueGate(10)}`);
save({
  filename: '03-functions-10.rules',
  description: '10 functions with unique gates — well under limits',
  compiles: true, runtime: 'pass', failureReason: '',
  lintRules: [],
  source: fns10,
  metrics: { sizeBytes: fns10.length, lines: fns10.split('\n').length, functions: 10, maxLetsPerFunction: 0, allowRules: 10, sharedGates: false, estimatedMaxExprPerRule: 2 },
});

// 4. 8 rules with unique gates (safe)
const gates8 = wrap(`${nFunctions(8)}
${allowRulesUniqueGate(8)}`);
save({
  filename: '04-unique-gates-8.rules',
  description: '8 allow rules with unique gates — no budget risk',
  compiles: true, runtime: 'pass', failureReason: '',
  lintRules: [],
  source: gates8,
  metrics: { sizeBytes: gates8.length, lines: gates8.split('\n').length, functions: 8, maxLetsPerFunction: 0, allowRules: 8, sharedGates: false, estimatedMaxExprPerRule: 2 },
});

// ═══════════════════════════════════════════════════════════════
// CORPUS: Known-bad rules (should NOT compile)
// ═══════════════════════════════════════════════════════════════

// 5. 13 let bindings (over the limit)
const letsBad = wrap(`${fnWithLets('check13', 13)}
      allow update: if check13();`);
save({
  filename: '05-lets-13-fail.rules',
  description: '13 let bindings in one function — EXCEEDS limit, fails to compile',
  compiles: false, runtime: 'fail', failureReason: 'Let binding limit exceeded (~10 max). 400 INVALID_ARGUMENT.',
  lintRules: ['LET_LIMIT'],
  source: letsBad,
  metrics: { sizeBytes: letsBad.length, lines: letsBad.split('\n').length, functions: 1, maxLetsPerFunction: 13, allowRules: 1, sharedGates: false, estimatedMaxExprPerRule: 13 },
});

// 6. 11 let bindings (at the limit — VERIFIED compiles on 2026-04-07)
const lets11 = wrap(`${fnWithLets('check11', 11)}
      allow update: if check11();`);
save({
  filename: '06-lets-11-ok.rules',
  description: '11 let bindings — at the exact limit, compiles (VERIFIED against production)',
  compiles: true, runtime: 'pass', failureReason: '',
  lintRules: [],
  source: lets11,
  metrics: { sizeBytes: lets11.length, lines: lets11.split('\n').length, functions: 1, maxLetsPerFunction: 11, allowRules: 1, sharedGates: false, estimatedMaxExprPerRule: 11 },
});

// 6b. 12 let bindings (OVER the limit — VERIFIED fails on 2026-04-07)
const lets12 = wrap(`${fnWithLets('check12', 12)}
      allow update: if check12();`);
save({
  filename: '06b-lets-12-fail.rules',
  description: '12 let bindings — OVER the limit, fails to compile (VERIFIED against production)',
  compiles: false, runtime: 'fail', failureReason: 'Let binding limit exceeded. Exact limit is 11 per function. 400 INVALID_ARGUMENT.',
  lintRules: ['LET_LIMIT'],
  source: lets12,
  metrics: { sizeBytes: lets12.length, lines: lets12.split('\n').length, functions: 1, maxLetsPerFunction: 12, allowRules: 1, sharedGates: false, estimatedMaxExprPerRule: 12 },
});

// 7. Size limit test — VERIFIED: 50KB of simple functions compiles fine.
// The "30-37KB limit" is actually a COMPLEXITY limit, not a raw size limit.
// Simple functions (1-2 expressions each) can be 50KB+.
// Complex functions (many OR branches, nested access) fail at ~30-37KB.
// For the linter, size alone is a WARNING, not an error. Complexity analysis is needed.
const bigBody = Array.from({ length: 400 }, (_, i) =>
  `      function pad${i}() {\n        return request.resource.data.field${i} == 'value${i}'\n            && request.resource.data.other${i} != '';\n      }`
).join('\n');
const bigRules = wrap(`${bigBody}
      allow update: if pad0();`);
save({
  filename: '07-large-50k-simple.rules',
  description: '~56KB of simple functions — COMPILES (verified). Size alone is not the limit; complexity is.',
  compiles: true, runtime: 'pass', failureReason: '',
  lintRules: ['SIZE_WARNING'],
  source: bigRules,
  metrics: { sizeBytes: bigRules.length, lines: bigRules.split('\n').length, functions: 400, maxLetsPerFunction: 0, allowRules: 1, sharedGates: false, estimatedMaxExprPerRule: 2 },
});

// ═══════════════════════════════════════════════════════════════
// CORPUS: Compiles but fails at runtime (hardest to detect)
// ═══════════════════════════════════════════════════════════════

// 8. Shared gates — 12 rules all with moveType == 'normal'
// Each rule has a moderately complex function. The first rule consumes
// budget, causing later rules to silently fail.
const sharedFns = Array.from({ length: 12 }, (_, i) => {
  const lets = Array.from({ length: 5 }, (_, j) =>
    `        let v${j} = request.resource.data.f${i}_${j};`
  ).join('\n');
  return `      function complex${i}() {\n${lets}\n        return v0 != '' && v1 != '' && v2 != '' && v3 != '' && v4 != '';\n      }`;
}).join('\n');
const sharedGates = wrap(`${sharedFns}
${Array.from({ length: 12 }, (_, i) =>
  `      allow update: if request.resource.data.moveType == 'normal'\n            && complex${i}();`
).join('\n')}`);
save({
  filename: '08-shared-gates-12.rules',
  description: '12 allow rules sharing moveType=="normal" gate — compiles but later rules may fail at runtime due to cross-rule budget',
  compiles: true, runtime: 'partial', failureReason: 'Cross-rule expression budget exhaustion. Later rules silently denied with 403.',
  lintRules: ['SHARED_GATE', 'CROSS_RULE_BUDGET'],
  source: sharedGates,
  metrics: { sizeBytes: sharedGates.length, lines: sharedGates.split('\n').length, functions: 12, maxLetsPerFunction: 5, allowRules: 12, sharedGates: true, estimatedMaxExprPerRule: 6 },
});

// 9. Same 12 rules but with unique gates — should work
const uniqueGates12 = wrap(`${sharedFns}
${Array.from({ length: 12 }, (_, i) =>
  `      allow update: if request.resource.data.moveType == 'type${i}'\n            && complex${i}();`
).join('\n')}`);
save({
  filename: '09-unique-gates-12.rules',
  description: '12 allow rules with unique gates — same functions as 08 but no budget risk',
  compiles: true, runtime: 'pass', failureReason: '',
  lintRules: [],
  source: uniqueGates12,
  metrics: { sizeBytes: uniqueGates12.length, lines: uniqueGates12.split('\n').length, functions: 12, maxLetsPerFunction: 5, allowRules: 12, sharedGates: false, estimatedMaxExprPerRule: 6 },
});

// 10. Deep function call chain
const deepChain = wrap(`
      function level5() { return request.resource.data.a != ''; }
      function level4() { return level5() && request.resource.data.b != ''; }
      function level3() { return level4() && request.resource.data.c != ''; }
      function level2() { return level3() && request.resource.data.d != ''; }
      function level1() { return level2() && request.resource.data.e != ''; }
      function level0() { return level1() && request.resource.data.f != ''; }
      allow update: if level0();`);
save({
  filename: '10-deep-call-chain.rules',
  description: '6-level function call chain — tests call depth limits',
  compiles: true, runtime: 'pass', failureReason: '',
  lintRules: ['CALL_DEPTH'],
  source: deepChain,
  metrics: { sizeBytes: deepChain.length, lines: deepChain.split('\n').length, functions: 6, maxLetsPerFunction: 0, allowRules: 1, sharedGates: false, estimatedMaxExprPerRule: 12 },
});

// ═══════════════════════════════════════════════════════════════
// CORPUS: Real-world rules from package-local fixtures
// ═══════════════════════════════════════════════════════════════

// 11-15: Fixture rules files with metadata
// These are referenced by path, not generated.

// ═══ Write corpus manifest ═══

const manifest = {
  generated: new Date().toISOString(),
  description: 'Linter test corpus — rules files with known compile/runtime outcomes',
  entries: corpus,
  realWorldFiles: [
    {
      filename: 'packages/pyric/test/fixtures/firestore-game-rules/chess.rules',
      description: 'Full chess rules — 17/17 production tests pass',
      compiles: true, runtime: 'pass', failureReason: '',
      lintRules: [],
      metrics: { sizeBytes: 24833, lines: 518, functions: 25, maxLetsPerFunction: 8, allowRules: 20, sharedGates: false, estimatedMaxExprPerRule: 94 },
    },
    {
      filename: 'packages/pyric/test/fixtures/firestore-game-rules/checkers-lookup.rules',
      description: 'Checkers with lookup doc — 13/13 production tests pass',
      compiles: true, runtime: 'pass', failureReason: '',
      lintRules: [],
      metrics: { sizeBytes: 7039, lines: 86, functions: 12, maxLetsPerFunction: 4, allowRules: 8, sharedGates: false, estimatedMaxExprPerRule: 20 },
    },
    {
      filename: 'packages/pyric/test/fixtures/firestore-game-rules/checkers-hardcoded.rules',
      description: 'Checkers with hardcoded OR branches — production tested',
      compiles: true, runtime: 'pass', failureReason: '',
      lintRules: ['SHARED_GATE'],
      metrics: { sizeBytes: 30583, lines: 611, functions: 20, maxLetsPerFunction: 3, allowRules: 16, sharedGates: true, estimatedMaxExprPerRule: 200 },
    },
    {
      filename: 'packages/pyric/test/fixtures/firestore-game-rules/connect-four.rules',
      description: 'Connect Four — production tested, placement game',
      compiles: true, runtime: 'pass', failureReason: '',
      lintRules: [],
      metrics: { sizeBytes: 23987, lines: 312, functions: 3, maxLetsPerFunction: 0, allowRules: 5, sharedGates: false, estimatedMaxExprPerRule: 130 },
    },
    {
      filename: 'historical-gomoku.rules',
      description: 'Gomoku — 175KB, likely exceeds all limits',
      compiles: false, runtime: 'fail', failureReason: 'Source size ~175KB far exceeds practical limit',
      lintRules: ['SIZE_LIMIT'],
      metrics: { sizeBytes: 175368, lines: 0, functions: 0, maxLetsPerFunction: 0, allowRules: 0, sharedGates: false, estimatedMaxExprPerRule: 0 },
    },
  ],
};

writeFileSync(join(OUT, 'CORPUS.json'), JSON.stringify(manifest, null, 2));

console.log('=== Linter Test Corpus Generated ===\n');
console.log(`Generated files: ${corpus.length}`);
for (const e of corpus) {
  const icon = e.compiles ? (e.runtime === 'pass' ? '✓' : '⚠') : '✗';
  console.log(`  ${icon} ${e.filename} — ${e.description}`);
  console.log(`    compiles: ${e.compiles}, runtime: ${e.runtime}, size: ${e.metrics.sizeBytes} bytes`);
  if (e.lintRules.length > 0) console.log(`    should trigger: ${e.lintRules.join(', ')}`);
}
console.log(`\nReal-world files: ${manifest.realWorldFiles.length}`);
for (const e of manifest.realWorldFiles) {
  const icon = e.compiles ? (e.runtime === 'pass' ? '✓' : '⚠') : '✗';
  console.log(`  ${icon} ${e.filename} — ${e.description}`);
}
console.log(`\nManifest: CORPUS.json`);
