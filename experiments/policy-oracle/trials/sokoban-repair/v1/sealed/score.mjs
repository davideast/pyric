import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [runtime, stockFile, ...revisions] = process.argv.slice(2);
assert.ok(stockFile, 'usage: node score.mjs <pinned-runtime-dir> <stock.rules> [initial.rules revision-1.rules ...]');
const require = createRequire(resolve(runtime, 'package.json'));
const pkg = dirname(require.resolve('@pyric/rules/package.json'));
const { firestoreRules, timestamp, serverTimestamp } = await import(pathToFileURL(join(pkg, 'dist/index.js')));
const { cases } = JSON.parse(readFileSync(new URL('cases.json', import.meta.url), 'utf8'));
assert.equal(new Set(cases.map(row => row.id)).size, cases.length);
const stockHash = '59b6e23b4727912311ffd45dcba50d4bcb69fe9ed79c6627584e385c338e422b';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const label = (row, decision) => row.expected === decision ? 'pass' : decision === 'ALLOW' ? 'falseAllow' : 'falseDenial';

function evaluate(file) {
  const bytes = readFileSync(file);
  const inputs = cases.map(row => {
    assert.equal(row.proposal.createdAt, '$serverTimestamp');
    return {
      description: row.id,
      expectation: 'ALLOW', // constant API placeholder; scoring consumes only the absolute decision
      method: 'update',
      path: row.path,
      auth: row.actor === null ? null : { uid: row.actor },
      resource: { ...row.before, createdAt: timestamp(row.before.createdAt) },
      data: { ...row.proposal, createdAt: serverTimestamp() },
      writeMode: { kind: 'set', merge: false },
      requestTime: row.requestTime,
    };
  });
  const evaluated = firestoreRules(bytes.toString('utf8')).simulate(inputs).cases;
  assert.deepEqual(evaluated.map(row => row.description), cases.map(row => row.id));
  const results = evaluated.map((result, i) => {
    const { id, category, expected } = cases[i];
    assert.ok(!result.unsupported && !result.resourceLimit && ['ALLOW', 'DENY'].includes(result.decision),
      'unscorable row '+id+' in '+file);
    return { id, category, expected, decision: result.decision, outcome: label(cases[i], result.decision) };
  });
  return {
    sha256: hash(bytes),
    total: results.length,
    passes: results.filter(row => row.outcome === 'pass').length,
    falseAllows: results.filter(row => row.outcome === 'falseAllow').map(row => row.id),
    falseDenials: results.filter(row => row.outcome === 'falseDenial').map(row => row.id),
    results,
  };
}
function delta(previous, current) {
  const previousPass = new Set(previous.results.filter(row => row.outcome === 'pass').map(row => row.id));
  return {
    previousPassesBroken: current.results.filter(row => row.outcome !== 'pass' && previousPass.has(row.id)).map(row => row.id),
    previousFailuresRepaired: current.results.filter(row => row.outcome === 'pass' && !previousPass.has(row.id)).map(row => row.id),
  };
}
assert.equal(hash(readFileSync(stockFile)), stockHash, 'full pinned Arcade stock file required');
const stock = evaluate(stockFile);
assert.equal(stock.passes, cases.length, 'expectations must corroborate against pinned complete stock');
const scores = revisions.map(evaluate);
const comparisons = scores.slice(1).map((score, i) => ({
  from: scores[i].sha256, to: score.sha256, ...delta(scores[i], score),
}));
console.log(JSON.stringify({ stock, revisions: scores, comparisons }, null, 2));
