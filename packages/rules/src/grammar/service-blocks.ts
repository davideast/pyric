import type { FirestoreRules, MatchBlock, ServiceBlock } from './FirestoreAST.js';

export type LintTargetService = 'cloud.firestore' | 'firebase.storage' | 'all';

export function isFirestoreServiceName(name: string | undefined): boolean {
  return name === 'cloud.firestore';
}

export function isStorageServiceName(name: string | undefined): boolean {
  return name === 'firebase.storage' || name === 'cloud.storage';
}

export function isRecognizedServiceName(name: string | undefined): boolean {
  return isFirestoreServiceName(name) || isStorageServiceName(name);
}

export function allServiceBlocks(
  ast: Pick<FirestoreRules, 'service' | 'services'>,
): ServiceBlock[] {
  if (ast.services !== undefined && ast.services.length > 0) {
    return ast.services;
  }
  if (ast.service !== undefined) {
    return [ast.service];
  }
  return [];
}

export function firestoreServiceBlock(
  ast: Pick<FirestoreRules, 'service' | 'services'>,
): ServiceBlock | undefined {
  if (isFirestoreServiceName(ast.service?.name)) {
    return ast.service;
  }
  return ast.services?.find((service) => isFirestoreServiceName(service.name));
}

export function storageServiceBlock(
  ast: Pick<FirestoreRules, 'service' | 'services'>,
): ServiceBlock | undefined {
  if (isStorageServiceName(ast.service?.name)) {
    return ast.service;
  }
  return ast.services?.find((service) => isStorageServiceName(service.name));
}

export function selectServicesToAnalyze(
  ast: Pick<FirestoreRules, 'service' | 'services'>,
  targetService: LintTargetService | undefined,
): ServiceBlock[] {
  const allServices = allServiceBlocks(ast);
  if (targetService === 'all') {
    return allServices.filter((s) => isRecognizedServiceName(s.name));
  }
  if (targetService === 'firebase.storage') {
    return allServices.filter((s) => isStorageServiceName(s.name));
  }
  if (targetService === 'cloud.firestore') {
    return allServices.filter((s) => isFirestoreServiceName(s.name));
  }
  if (ast.service && isRecognizedServiceName(ast.service.name)) {
    return [ast.service];
  }
  return [];
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
