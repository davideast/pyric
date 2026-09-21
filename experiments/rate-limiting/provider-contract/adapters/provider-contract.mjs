import { scenarios } from '../scenarios/registry.mjs';
/** @param {{cases?: string[], limits?: {maxCommands?: number}, provider?: {kind?: string}}} input */
export function preflight(input = {}) {
    const errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ready: false, errors: ['Configuration must be an object'] };
    if (Object.keys(input).some(k => !['cases', 'limits', 'provider'].includes(k))) errors.push('Unknown configuration field; secrets are not capture inputs');
    const cases = input.cases ?? Object.keys(scenarios);
    if (!Array.isArray(cases) || !cases.length || cases.some(id => !Object.hasOwn(scenarios, id)) || new Set(cases).size !== cases.length) errors.push('Unknown, empty or duplicate cases');
    const limits = { maxCommands: 20000, ...input.limits };
    if (Object.keys(limits).some(k => k !== 'maxCommands') || !Number.isInteger(limits.maxCommands) || limits.maxCommands < 1 || limits.maxCommands > 20000) errors.push('maxCommands must be between 1 and 20000');
    const requiredCommands = Array.isArray(cases) ? cases.reduce((n, id) => n + (scenarios[id]?.maxCommands ?? 0), 0) : 0;
    if (limits.maxCommands < requiredCommands) errors.push('Selected cases exceed command budget');
    if (input.provider && (Object.keys(input.provider).some(k => k !== 'kind') || input.provider.kind !== 'controlled')) errors.push('Only controlled local execution is enabled; live inference requires a separate approved run');
    return { ready: errors.length === 0, errors, requiredCommands, maxTransactionAttempts: 8, runDeadlineMs: 50000, config: errors.length ? null : { cases, limits, provider: { kind: 'controlled' } } };
}
