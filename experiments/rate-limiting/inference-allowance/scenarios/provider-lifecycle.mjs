import { readdirSync } from 'node:fs';
import { lifecycleChecks } from '../analysis/provider-lifecycle.mjs';
const directory = new URL('./provider-lifecycle/', import.meta.url);
// File names identify authored scenarios; adding a file extends the registry.
const files = readdirSync(directory).filter(name => name.endsWith('.mjs')).sort();
export const lifecycleScenarios = Object.fromEntries(await Promise.all(files.map(async file => {
    const { default: scenario } = await import(new URL(file, directory).href);
    return [file.slice(0, -4), { ...scenario, lifecycle: true, execution: true,
        checks: ['all scheduled requests observed', 'HTTP status matches outcome', 'no client transport errors', 'all work settles', ...lifecycleChecks] }];
})));
export const lifecycleWorkload = {
    revision: 1, suite: 'provider-lifecycle', clockStart: 1000000, caseTimeoutMs: 15000,
    server: 'node-express-single-instance', generator: 'separate-node-process-open-loop',
    inference: 'scripted provider lifecycle; no real inference',
    authentication: 'synthetic fixture bearer tokens; not Firebase token verification',
};
