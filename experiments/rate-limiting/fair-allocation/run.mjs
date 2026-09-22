import { readFile } from 'node:fs/promises';
import { captureRun, verifyCapture } from '../../shared/evidence/capture.mjs';
import { captureDefinition } from './capture-definition.mjs';
import { compare, summarize } from './analysis/assess.mjs';
import { scenarios } from './scenarios/registry.mjs';

const [command, ...args] = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const json = async path => JSON.parse(await readFile(path, 'utf8'));

const ALLOWED_OPTIONS = ['--config', '--case', '--out', '--mode'];

try {
    let result;

    if (args.some(arg => arg.startsWith('--') && !ALLOWED_OPTIONS.includes(arg)))
        throw new Error('Unknown option; hosted execution requires explicit approval');

    if (command === 'preflight') {
        const definition = captureDefinition();
        result = { ready: true, experiment: definition.experiment, sourcePaths: definition.sourcePaths.length, scope: definition.scope };
        console.log(JSON.stringify(result, null, 2));

    } else if (command === 'run' || command === 'baseline') {
        const input = option('--config') ? await json(option('--config')) : { profile: 'local' };
        if (option('--case')) input.cases = [option('--case')];
        if (!scenarios[input.cases?.[0] ?? Object.keys(scenarios)[0]])
            throw new Error('Unknown case ID');
        result = await captureRun(
            option('--out') ?? '/tmp/fair-allocation-results',
            { definition: captureDefinition(), input },
        );
        if (!result.successfulExperiment) process.exitCode = 1;
        console.log(JSON.stringify(result, null, 2));

    } else if (command === 'replay') {
        result = await captureRun(
            option('--out') ?? '/tmp/fair-allocation-replays',
            { sourceCapture: args[0] },
        );
        if (!result.successfulExperiment) process.exitCode = 1;
        console.log(JSON.stringify(result, null, 2));

    } else if (command === 'verify') {
        result = await verifyCapture(args[0]);
        if (!result.valid) process.exitCode = 1;
        console.log(JSON.stringify(result, null, 2));

    } else if (command === 'analyze') {
        if (!(await verifyCapture(args[0])).valid) throw new Error('Invalid capture');
        result = summarize(await json(`${args[0]}/result.json`));
        console.log(JSON.stringify(result, null, 2));

    } else if (command === 'compare') {
        for (const dir of args.slice(0, 2))
            if (!(await verifyCapture(dir)).valid) throw new Error(`Invalid capture: ${dir}`);
        result = compare(
            await json(`${args[0]}/result.json`),
            await json(`${args[1]}/result.json`),
        );
        if (!result.compatible) process.exitCode = 1;
        console.log(JSON.stringify(result, null, 2));

    } else {
        throw new Error(
            'Usage: run [--case ID] [--config FILE] [--out DIR] | ' +
            'replay DIR [--out DIR] | verify DIR | analyze DIR | ' +
            'compare LEFT RIGHT | preflight [--config FILE]. ' +
            'Local only; no deployment command.',
        );
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 2;
}
