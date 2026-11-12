export type BundledRulesService = 'cloud.firestore' | 'firebase.storage';

const RULES_SERVICES = new Set<BundledRulesService>(['cloud.firestore', 'firebase.storage']);
const SERVICE_DIRECTIVE = /^\/\/ @pyric-services (.+)$/;
const EVIDENCE_DIRECTIVE = /^\/\/ @pyric-evidence (.+)$/;
const EVIDENCE_ID = /^(?:firestore|storage)-rules#[1-9][0-9]*$/;

export function servicesForRulesModule(file: string, content: string): BundledRulesService[] {
  const directive = content.split('\n', 1)[0]?.match(SERVICE_DIRECTIVE);
  if (!directive) throw new Error(`${file}: first line must declare // @pyric-services <service,...>`);
  const services = directive[1]!.split(',') as BundledRulesService[];
  if (services.length === 0 || new Set(services).size !== services.length ||
      services.some((service) => !RULES_SERVICES.has(service))) {
    throw new Error(`${file}: invalid @pyric-services declaration '${directive[1]}'`);
  }
  return services;
}

export function evidenceForRulesModule(file: string, content: string): string[] {
  const directive = content.split('\n', 2)[1]?.match(EVIDENCE_DIRECTIVE);
  if (!directive) return [];
  const evidenceIds = directive[1]!.split(',');
  if (new Set(evidenceIds).size !== evidenceIds.length ||
      evidenceIds.some((evidenceId) => !EVIDENCE_ID.test(evidenceId))) {
    throw new Error(`${file}: invalid @pyric-evidence declaration '${directive[1]}'`);
  }
  return evidenceIds;
}
