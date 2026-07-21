export type BundledRulesService = 'cloud.firestore' | 'firebase.storage';

const RULES_SERVICES = new Set<BundledRulesService>(['cloud.firestore', 'firebase.storage']);
const SERVICE_DIRECTIVE = /^\/\/ @pyric-services (.+)$/;

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
