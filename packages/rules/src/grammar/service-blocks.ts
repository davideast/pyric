import type { FirestoreRules, MatchBlock, ServiceBlock } from './FirestoreAST.js';

export function isStorageServiceName(name: string | undefined): boolean {
  return name === 'firebase.storage' || name === 'cloud.storage';
}

export function allServiceBlocks(
  ast: Pick<FirestoreRules, 'service' | 'services'>,
): ServiceBlock[] {
  if (ast.services !== undefined && ast.services.length > 0) {
    return ast.services;
  }
  return ast.service !== undefined ? [ast.service] : [];
}

export function withSingleService(ast: FirestoreRules, service: ServiceBlock): FirestoreRules {
  return { ...ast, service, services: [service] };
}

export function topLevelMatches(
  service: Pick<ServiceBlock, 'match' | 'matches'> | undefined,
): MatchBlock[] {
  if (!service) return [];
  if (service.matches !== undefined && service.matches.length > 0) {
    return service.matches;
  }
  if (service.match !== undefined) {
    return [service.match];
  }
  return [];
}
