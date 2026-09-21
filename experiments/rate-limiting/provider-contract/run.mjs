import { readFile } from 'node:fs/promises';
import { captureRun, verifyCapture } from '../../shared/evidence/capture.mjs';
import { captureDefinition } from './capture-definition.mjs';
import { preflight } from './adapters/provider-contract.mjs';
import { compare, summarize } from './analysis/assess.mjs';
const [command, ...args] = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
try {
    let result;
    const allowedOptions = ['--config', '--case', '--out'];
    if (args.some(arg => arg.startsWith('--') && !allowedOptions.includes(arg))) throw new Error('Unknown option; live execution and deployment are disabled');
    if (command === 'preflight') {
        result = preflight(option('--config') ? await json(option('--config')) : {}); if (!result.ready) process.exitCode = 1;
    } else if (command === 'run' || command === 'baseline') {
        const input = option('--config') ? await json(option('--config')) : {};
        if (option('--case')) input.cases = [option('--case')];
        const checked = preflight(input); if (!checked.ready) throw new Error(checked.errors.join('; '));
        result = await captureRun(option('--out') ?? '/tmp/provider-contract-results', { definition: captureDefinition(), input: checked.config });
        if (!result.successfulExperiment) process.exitCode = 1;
    } else if (command === 'replay') {
        result = await captureRun(option('--out') ?? '/tmp/provider-contract-replays', { sourceCapture: args[0] });
        if (!result.successfulExperiment) process.exitCode = 1;
    } else if (command === 'verify') {
        result = await verifyCapture(args[0]); if (!result.valid) process.exitCode = 1;
    } else if (command === 'analyze') {
        if (!(await verifyCapture(args[0])).valid) throw new Error('Invalid capture');
        result = summarize(await json(`${args[0]}/result.json`));
    } else if (command === 'compare') {
        for (const directory of args.slice(0, 2)) if (!(await verifyCapture(directory)).valid) throw new Error('Invalid capture');
        result = compare(await json(`${args[0]}/result.json`), await json(`${args[1]}/result.json`));
        if (!result.compatible) process.exitCode = 1;
    } else throw new Error('Usage: run [--case ID] [--out DIR] | replay DIR [--out DIR] | verify DIR | analyze DIR | compare LEFT RIGHT. Local only; no deployment command.');
    console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 2; }
