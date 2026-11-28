import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shared = await import(
  pathToFileURL(join(process.env.ORACLE_ROOT, 'adapters/_shared/v1/index.mjs')).href
);
const here = dirname(fileURLToPath(import.meta.url));
const policySource = shared.readText(join(here, 'policy.rules'));
const cases = shared.readJson(join(here, 'cases.json'));

const bindings = { before: 'data', after: 'newData' };

function wrapTree(validate) {
  return {
    rules: {
      '.read': false,
      '.write': false,
      presence: {
        '$uid': {
          '.write': 'auth != null && auth.uid == $uid && newData.exists()',
          '.validate': validate,
        },
      },
    },
  };
}

const output = await shared.scoreRtdbProbe({
  cases,
  compileCandidate: async (runtime) => {
    const { compilePolicy } = await runtime.policy();
    const compiled = compilePolicy(policySource);
    const rows = compiled.rtdb(bindings, 'complete');
    const validate = rows.map((row) => '(' + row.predicate + ')').join(' && ');
    const tree = wrapTree(validate);
    compiled.bind.rtdb({ path: '/presence/$uid', bindings, mode: 'complete' }).verify(tree);
    return tree;
  },
  compileMutant: async (runtime) => {
    const { compilePolicy } = await runtime.policy();
    const rows = compilePolicy(policySource).rtdb(bindings, 'complete');
    // Mutant omits windowRateLimit (allows bursts and premature window resets).
    const kept = rows.filter((row) => row.requirement !== 'windowRateLimit');
    return wrapTree(kept.map((row) => '(' + row.predicate + ')').join(' && '));
  },
});

shared.emitProbeOutput(output, cases.map((c) => c.id));
