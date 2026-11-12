import type { MatchBlock, ServiceBlock } from './FirestoreAST.js';

export function isStorageServiceName(name: string | undefined): boolean {
  return name === 'firebase.storage' || name === 'cloud.storage';
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
