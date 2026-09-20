import { readFile, writeFile } from 'node:fs/promises';
import { captureRun, verifyCapture } from '../../shared/evidence/capture.mjs';
import { captureDefinition } from './capture-definition.mjs';
import { compareRuns } from './analysis/assess.mjs';
import { summarize } from './analysis/summarize.mjs';
const [command, ...args] = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
import { preflight } from './adapters/preflight.mjs';
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
try {
    let value;
    if (command === 'run') {
        const config = option('--config') ? await json(option('--config')) : { profile: 'local' };
        if (config.suite && (!['http-overload', 'provider-lifecycle'].includes(config.suite) || config.profile !== 'local'))
            throw new Error('HTTP overload currently supports local Pyric only');
        if (config.profile !== 'local') {
            const report = await preflight(config);
            if (config.profile !== 'firestore-comparison' || !args.includes('--allow-production') || !report.configurationValid)
                throw new Error('Production requires a valid firestore-comparison config and --allow-production; AI integration is preflight-only');
            process.env.PYRIC_ALLOWANCE_PRODUCTION = 'explicit';
        }
        value = await captureRun(option('--out') ?? '/tmp/allowance-results', { definition: captureDefinition(), input: { ...config, cases: option('--case') ? [option('--case')] : config.cases } });
        if (!value.successfulExperiment)
            process.exitCode = 1;
    }
    else if (command === 'preflight') {
        value = await preflight(await json(option('--config') ?? args[0]), { probe: args.includes('--probe') });
        if (!value.ready)
            process.exitCode = 2;
    }
    else if (command === 'verify') {
        value = await verifyCapture(args[0]);
        if (!value.valid)
            process.exitCode = 1;
    }
    else if (command === 'analyze') {
        value = summarize(await json(`${args[0]}/result.json`));
    }
    else if (command === 'compare') {
        for (const path of args.slice(0, 2)) {
            const integrity = await verifyCapture(path);
            if (!integrity.valid)
                throw new Error('Capture verification failed: ' + path);
        }
        value = compareRuns(await json(`${args[0]}/result.json`), await json(`${args[1]}/result.json`));
        if (option('--out'))
            await writeFile(option('--out'), JSON.stringify(value, null, 2) + '\n');
        if (!value.compatible)
            process.exitCode = 2;
    }
    else if (command === 'baseline') {
        delete process.env.PYRIC_ALLOWANCE_PRODUCTION;
        if (!(await verifyCapture(args[0])).valid)
            throw new Error('Capture verification failed');
        const original = await json(`${args[0]}/input.json`);
        value = await captureRun(option('--out') ?? '/tmp/allowance-baselines', { sourceCapture: args[0], input: { profile: 'local', ...(original.suite ? { suite: original.suite } : {}), cases: original.cases, limits: original.limits } });
        if (!value.successfulExperiment)
            process.exitCode = 1;
    }
    else if (command === 'replay') {
        delete process.env.PYRIC_ALLOWANCE_PRODUCTION;
        value = await captureRun(option('--out') ?? '/tmp/allowance-replays', { sourceCapture: args[0] });
        if (!value.successfulExperiment)
            process.exitCode = 1;
    }
    else
        throw new Error('Usage: run [--config PATH] [--case ID] [--out DIR] | verify DIR | analyze DIR | compare DIR DIR [--out FILE] | baseline DIR [--out DIR] | replay DIR [--out DIR] | preflight --config PATH [--probe]');
    console.log(JSON.stringify(value, null, 2));
}
catch (error) {
    console.error(error.message);
    process.exitCode = 2;
}
