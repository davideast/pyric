import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { googleApi } from './google-api.mjs';
import { configuration } from './requirements.mjs';
import { inspect } from './inspection.mjs';
import { plan, apply } from './planning.mjs';
import { preflight } from './preflight.mjs';

const help = `Usage: node setup-observability.mjs check|plan|preflight --project ID --database ID --service NAME --region REGION --collector user:EMAIL|serviceAccount:EMAIL [options]
       node setup-observability.mjs apply --plan FILE [options]
Options:
  --credentials FILE            Service account key (otherwise ADC)
  --collector-credentials FILE  Separate log-reader credential (otherwise caller)
  --out DIRECTORY              Save report/plan here (default: ./observability-<mode>-<timestamp>)
  --location LOCATION          Dedicated log bucket location (default global)
  --retention DAYS             Minimum retention; never shorten (default manifest)
  --optional auth,ai,rtdb       Only inspect services used by your workload
  --identity-token-file FILE   Cloud Run invoker ID token for preflight only
  --timeout-ms N               Preflight ingestion wait (default 120000; max 300000)
check/plan make read-only API calls. apply changes reviewed configuration.
preflight invokes the experiment endpoint, which creates, reads and deletes one canary document.
Exit: 0 ready/planned/applied, 1 incomplete/blocked, 2 usage/API failure.
`;

export async function runCli(argv, manifest, dependencies = {}) {
    const strings = ['project', 'database', 'service', 'region', 'collector', 'credentials', 'collector-credentials', 'out', 'location', 'retention', 'optional', 'plan', 'identity-token-file', 'timeout-ms'];
    /** @type {Record<string, {type: 'string' | 'boolean'}>} */
    const options = { help: { type: 'boolean' }, ...Object.fromEntries(strings.map(k => [k, { type: 'string' }])) };
    const { positionals, values: parsed } = parseArgs({ args: argv, allowPositionals: true, options });
    if (parsed.help) { (dependencies.print ?? console.log)(help); return 0; }
    /** @type {Record<string, string>} */
    const values = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') values[key] = value;
    const mode = positionals[0];
    if (positionals.length !== 1 || !['check', 'plan', 'apply', 'preflight'].includes(mode)) throw new Error(help);
    if (mode !== 'preflight' && (values['identity-token-file'] || values['timeout-ms'])) throw new Error('Invocation options are only valid for preflight');
    let saved, config;
    if (mode === 'apply') {
        if (!values.plan) throw new Error('--plan is required');
        if (strings.filter(k => !['plan', 'out', 'credentials', 'collector-credentials'].includes(k)).some(k => values[k])) throw new Error('Apply uses the reviewed plan target; do not override it');
        saved = JSON.parse(await readFile(resolve(values.plan), 'utf8'));
        config = configuration({ ...saved.config, optional: saved.config.optional.join(','), retention: saved.config.retentionDays }, manifest);
        if (JSON.stringify(config) !== JSON.stringify(saved.config)) throw new Error('Invalid plan target');
    } else {
        if (values.plan) throw new Error('--plan is only valid for apply');
        config = configuration(values, manifest);
    }
    const directory = resolve(values.out ?? `observability-${mode}-${Date.now()}`);
    await mkdir(directory, { recursive: true });
    const save = (name, data) => writeFile(join(directory, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    const api = dependencies.api ?? await googleApi({ project: config.project, credentials: values.credentials });
    let collectorApi = dependencies.collectorApi ?? api;
    if (values['collector-credentials']) collectorApi = await googleApi({ project: config.project, credentials: values['collector-credentials'] });
    if (/^(serviceAccount|user):/.test(collectorApi.identity) && collectorApi.identity !== config.collector) throw new Error('Collector credential does not match --collector; supply --collector-credentials');
    if (mode === 'apply') {
        const result = await apply(api, collectorApi, saved, manifest, progress => save('apply-progress.json', progress));
        await save('apply-result.json', result);
        if (result.report) await save('observability-report.json', result.report);
        (dependencies.print ?? console.log)(JSON.stringify({ directory, status: result.status,
            projectConfigurationReady: result.report?.projectConfigurationReady,
            configurationReady: result.report?.configurationReady, evidenceComplete: false }));
        return result.report?.projectConfigurationReady ? 0 : 1;
    }
    let report = await inspect(api, collectorApi, config, manifest);
    await save('observability-report.json', report);
    if (mode === 'plan') {
        const proposed = plan(report);
        await save('plan-observability-report.json', report);
        await save('observability-plan.json', proposed);
        (dependencies.print ?? console.log)(JSON.stringify({ directory, actions: proposed.actions.map(a => a.id), blockers: proposed.blockers, warnings: proposed.warnings }));
        return proposed.blockers.length ? 1 : 0;
    }
    if (mode === 'preflight') {
        const identityToken = values['identity-token-file'] ? await readFile(resolve(values['identity-token-file']), 'utf8') : undefined;
        report = await preflight(report, collectorApi, { identityToken, timeoutMs: Number(values['timeout-ms'] ?? 120000),
            ...dependencies.preflight, persist: value => save('observability-report.json', value) });
    }
    (dependencies.print ?? console.log)(JSON.stringify({ directory, projectConfigurationReady: report.projectConfigurationReady,
        configurationReady: report.configurationReady, evidenceComplete: report.evidenceComplete, checks: report.checks }));
    if (mode === 'preflight') return report.evidenceComplete ? 0 : 1;
    return report.configurationReady ? 0 : 1;
}
