import {
  STDLIB_SERVICE_CONTRACT_MODULES,
  STDLIB_SERVICE_CONTRACTS,
} from './stdlib-services.generated.js';

export type RulesServiceName = 'cloud.firestore' | 'firebase.storage';

export { STDLIB_SERVICE_CONTRACT_MODULES };

function stdlibContractKey(moduleName: string): string {
  const pathMatch = moduleName.match(/^\.\/stdlib\/(.+?)(?:\.rules)?$/);
  return pathMatch?.[1] ?? moduleName;
}

export function incompatibleStdlibExport(
  service: RulesServiceName,
  moduleName: string,
  functionName: string,
): string | null {
  const contractKey = stdlibContractKey(moduleName);
  const services = STDLIB_SERVICE_CONTRACTS[contractKey as keyof typeof STDLIB_SERVICE_CONTRACTS] as
    readonly RulesServiceName[] | undefined;
  if (!services) return null;
  return services.includes(service)
    ? null
    : `Function '${functionName}' from module '${moduleName}' is not compatible with service '${service}'`;
}
