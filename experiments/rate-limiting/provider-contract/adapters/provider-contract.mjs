import { scenarios } from '../scenarios/registry.mjs';
/** @param {{cases?: string[], limits?: {maxCommands?: number}, provider?: {kind?: string}}} input */
export function preflight(input = {}) {
    const errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ready: false, errors: ['Configuration must be an object'] };
    if (Object.keys(input).some(k => !['cases', 'limits', 'provider'].includes(k))) errors.push('Unknown configuration field; secrets are not capture inputs');
    const cases = input.cases ?? Object.keys(scenarios);
    if (!Array.isArray(cases) || !cases.length || cases.some(id => !Object.hasOwn(scenarios, id)) || new Set(cases).size !== cases.length) errors.push('Unknown, empty or duplicate cases');
    const limits = { maxCommands: 20000, ...input.limits };
    if (Object.keys(limits).some(k => k !== 'maxCommands') || !Number.isInteger(limits.maxCommands) || limits.maxCommands < 1000 || limits.maxCommands > 20000) errors.push('maxCommands must be between 1000 and 20000');
    if (input.provider && (Object.keys(input.provider).some(k => k !== 'kind') || input.provider.kind !== 'controlled')) errors.push('Only controlled local execution is enabled; live inference requires a separate approved run');
    return { ready: errors.length === 0, errors, config: errors.length ? null : { cases, limits, provider: { kind: 'controlled' } } };
}
