import { STORAGE_BINDING_PATHS } from './rules-capabilities.generated.js';
import type { RulesServiceName } from './stdlib-service-compatibility.js';

const STORAGE_BINDINGS = new Set<string>(STORAGE_BINDING_PATHS);
const STORAGE_DYNAMIC_BINDING_PREFIXES = [
  'request.auth.token',
  'request.resource.metadata',
  'resource.metadata',
] as const;

export function allowedAmbientBinding(service: RulesServiceName, path: readonly string[]): boolean {
  if (path.length === 1) return true;
  if (service === 'firebase.storage') {
    const binding = path.join('.');
    return STORAGE_BINDINGS.has(binding) ||
      STORAGE_DYNAMIC_BINDING_PREFIXES.some((prefix) => binding.startsWith(`${prefix}.`));
  }
  if (path[0] === 'request') {
    if (path[1] === 'auth' || path[1] === 'query') return true;
    if (['time', 'method', 'path'].includes(path[1]!)) return path.length === 2;
    return path[1] === 'resource' && (path.length === 2 || path[2] === 'data');
  }
  return path[0] === 'resource' && (path.length === 1 || path[1] === 'data');
}

export function allowsDynamicAmbientAccess(
  service: RulesServiceName,
  path: readonly string[],
): boolean {
  if (path[0] === 'request' && path[1] === 'auth' && path[2] === 'token') return true;
  if (service === 'firebase.storage') {
    return path[0] === 'resource' && path[1] === 'metadata' ||
      path[0] === 'request' && path[1] === 'resource' && path[2] === 'metadata';
  }
  return path[0] === 'resource' && path[1] === 'data' ||
    path[0] === 'request' && path[1] === 'resource' && path[2] === 'data' ||
    path[0] === 'request' && path[1] === 'query';
}
