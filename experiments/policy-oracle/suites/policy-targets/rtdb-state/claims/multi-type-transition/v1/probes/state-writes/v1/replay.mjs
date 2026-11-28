import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shared = await import(
  pathToFileURL(join(process.env.ORACLE_ROOT, 'adapters/_shared/v1/index.mjs')).href
);
const here = dirname(fileURLToPath(import.meta.url));
const policySource = shared.readText(join(here, 'policy.rules'));
const cases = shared.readJson(join(here, 'cases.json'));

const bindings = { before: 'data', after: 'newData' };

const output = await shared.scoreRtdbProbe({
  cases,
  compileCandidate: async (runtime) => {
    const { compilePolicy } = await runtime.policy();
    const rows = compilePolicy(policySource).rtdb(bindings, 'complete');
    const validate = rows.map((row) => `(${row.predicate})`).join(' && ');
    return { rules: { state: { '.write': 'newData.exists()', '.validate': validate } } };
  },
  compileMutant: async (runtime) => {
    const { compilePolicy } = await runtime.policy();
    const [stepRow] = compilePolicy(policySource).rtdb(bindings, 'complete');
    return { rules: { state: { '.write': 'newData.exists()', '.validate': stepRow.predicate } } };
  },
});

shared.emitProbeOutput(output, cases.map((c) => c.id));
