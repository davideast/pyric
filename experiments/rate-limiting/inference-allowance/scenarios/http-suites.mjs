import { httpScenarios, httpWorkload } from './http-overload.mjs';
import { lifecycleScenarios, lifecycleWorkload } from './provider-lifecycle.mjs';
export function httpSuite(name) {
    if (name === 'http-overload') return { scenarios: httpScenarios, workload: httpWorkload };
    if (name === 'provider-lifecycle') return { scenarios: lifecycleScenarios, workload: lifecycleWorkload };
    throw new Error('Invalid HTTP suite');
}
