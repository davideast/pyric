import { AuthIR, AuthProviderId, AuthIRGenerationError } from './types.js';

export class AuthMapper {
  static mapToIR(idpData: any, configData: any): AuthIR {
    if (!idpData || typeof idpData !== 'object') {
      throw new AuthIRGenerationError('idpData', 'Invalid or missing IDP data payload');
    }
    if (!configData || typeof configData !== 'object') {
      throw new AuthIRGenerationError('configData', 'Invalid or missing config data payload');
    }

    const enabledProviders: AuthProviderId[] = (idpData.defaultSupportedIdpConfigs || [])
      .filter((config: any) => config.enabled === true) // absent enabled field means disabled
      .map((config: any) => {
        if (!config || !config.name) {
          throw new AuthIRGenerationError('name', 'IDP config is missing name field');
        }
        const parts = config.name.split('/');
        return parts[parts.length - 1] as AuthProviderId;
      });

    const signIn = configData.signIn;
    if (!signIn || typeof signIn !== 'object') {
      throw new AuthIRGenerationError('signIn', 'Config data is missing signIn configuration');
    }

    const allowPasswordSignup = signIn.email?.enabled === true;
    // API returns {} not undefined when disabled
    const enableAnonymousUser = signIn.anonymous?.enabled === true;
    const enablePhone = signIn.phoneNumber?.enabled === true;

    // Merge config-based providers into enabledProviders
    // (OAuth providers come from defaultSupportedIdpConfigs, but email/anonymous/phone
    // are in the signIn config, not the IDP list)
    if (allowPasswordSignup && !enabledProviders.includes('password')) {
      enabledProviders.push('password');
    }
    if (enableAnonymousUser && !enabledProviders.includes('anonymous')) {
      enabledProviders.push('anonymous');
    }
    if (enablePhone && !enabledProviders.includes('phone')) {
      enabledProviders.push('phone');
    }

    return {
      service: "authentication",
      enabledProviders,
      settings: {
        allowPasswordSignup,
        enableAnonymousUser
      }
    };
  }
}
