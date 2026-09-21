import { readFile } from 'node:fs/promises';
import { captureRun, verifyCapture } from '../../../shared/evidence/capture.mjs';
import { captureDefinition } from './capture-definition.mjs';
import { inspectTarget } from './target.mjs';
import { validateConfig } from './config.mjs';
import { assessLive } from './assess.mjs';
const [command, ...args] = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
try {
    const known = ['--config', '--credentials', '--auth-credentials', '--firebase-config', '--out', '--allow-real-inference'];
    if (args.some(a => a.startsWith('--') && !known.includes(a))) throw new Error('Unknown option');
    let result;
    if (command === 'preflight' || command === 'run') {
        const config = validateConfig(await json(option('--config')));
        const options = { credentials: option('--credentials'), firebaseConfigPath: option('--firebase-config') };
        const target = await inspectTarget(config, options);
        if (command === 'preflight') result = target.publicReport;
        else {
            if (!args.includes('--allow-real-inference') || !option('--auth-credentials')) throw new Error('Live run requires --allow-real-inference and --auth-credentials');
            process.env.PYRIC_PROVIDER_REAL_RUN = '1'; process.env.PYRIC_PROVIDER_CREDENTIALS = options.credentials;
            process.env.PYRIC_PROVIDER_AUTH_CREDENTIALS = option('--auth-credentials');
            if (options.firebaseConfigPath) process.env.PYRIC_PROVIDER_FIREBASE_CONFIG = options.firebaseConfigPath;
            try { result = await captureRun(option('--out') ?? '/tmp/provider-contract-live', { definition: captureDefinition(), input: config }); }
            finally { delete process.env.PYRIC_PROVIDER_REAL_RUN; delete process.env.PYRIC_PROVIDER_CREDENTIALS; delete process.env.PYRIC_PROVIDER_AUTH_CREDENTIALS; delete process.env.PYRIC_PROVIDER_FIREBASE_CONFIG; }
            if (!result.successfulExperiment) process.exitCode = 1;
        }
    } else if (command === 'verify') {
        result = await verifyCapture(args[0]); if (!result.valid) process.exitCode = 2;
    } else if (command === 'analyze') {
        if (!(await verifyCapture(args[0])).valid) throw new Error('Capture verification failed');
        result = assessLive(await json(`${args[0]}/result.json`)); if (!result.successfulExperiment) process.exitCode = 1;
    } else if (command === 'replay') throw new Error('Live replay is disabled; analyze the saved evidence instead');
    else throw new Error('Usage: preflight|run --config PATH --credentials PATH [--auth-credentials PATH --allow-real-inference] [--out DIR]; verify|analyze CAPTURE');
    console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 2; }
