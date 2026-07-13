import type { ProjectScope } from '../../credentials/core/types.js';
import type { ConfigureProviderInput, ConfigureAuthResult, ProviderId } from './spec.js';

export class ConfigureProviderHandler {
  async execute(scope: ProjectScope, input: ConfigureProviderInput): Promise<ConfigureAuthResult> {
    try {
      switch (input.provider) {
        case 'anonymous':
          return await this.configureSimple(scope, input.provider, input.enabled, {
            updateMask: 'signIn.anonymous.enabled',
            body: { signIn: { anonymous: { enabled: input.enabled } } },
          });
        case 'email':
          return await this.configureSimple(scope, input.provider, input.enabled, {
            updateMask: 'signIn.email.enabled,signIn.email.passwordRequired',
            body: { signIn: { email: { enabled: input.enabled, passwordRequired: true } } },
          });
        case 'phone':
          return await this.configurePhone(scope, input.enabled);
        case 'google':
          return await this.configureGoogle(scope, input.enabled);
      }
    } catch (e) {
      return {
        success: false,
        error: {
          code: 'PROVIDER_CONFIG_FAILED',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        },
      };
    }
  }

  private async configureSimple(
    scope: ProjectScope,
    provider: ProviderId,
    enabled: boolean,
    opts: { updateMask: string; body: Record<string, unknown> },
  ): Promise<ConfigureAuthResult> {
    const token = await scope.resolveToken();
    const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${scope.projectId}/config?updateMask=${opts.updateMask}`;
    const patchRes = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body),
    });

    if (patchRes.status === 403) {
      return {
        success: false,
        error: { code: 'PERMISSION_DENIED', message: `Permission denied configuring ${provider}`, recoverable: false },
      };
    }

    if (!patchRes.ok) {
      const body = await patchRes.text().catch(() => '');
      return {
        success: false,
        error: { code: 'PROVIDER_CONFIG_FAILED', message: `Failed to configure ${provider}: ${patchRes.status} ${body}`, recoverable: false },
      };
    }

    return { success: true, provider, enabled };
  }

  private async configurePhone(scope: ProjectScope, enabled: boolean): Promise<ConfigureAuthResult> {
    const token = await scope.resolveToken();
    const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${scope.projectId}/config?updateMask=signIn.phoneNumber.enabled`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signIn: { phoneNumber: { enabled } } }),
    });

    if (res.status === 403) {
      return {
        success: false,
        error: { code: 'PERMISSION_DENIED', message: 'Permission denied configuring phone auth', recoverable: false },
      };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        success: false,
        error: { code: 'PROVIDER_CONFIG_FAILED', message: `Failed to configure phone: ${res.status} ${body}`, recoverable: false },
      };
    }

    return {
      success: true,
      provider: 'phone',
      enabled,
      warning: enabled
        ? 'Phone authentication requires a billing account for SMS delivery. Verify billing is enabled in the Google Cloud Console for this project.'
        : undefined,
    };
  }

  private async configureGoogle(scope: ProjectScope, enabled: boolean): Promise<ConfigureAuthResult> {
    const token = await scope.resolveToken();
    const baseUrl = `https://identitytoolkit.googleapis.com/admin/v2/projects/${scope.projectId}/defaultSupportedIdpConfigs/google.com`;

    const checkRes = await fetch(baseUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (checkRes.status === 404) {
      return {
        success: false,
        error: {
          code: 'GOOGLE_NOT_PROVISIONED',
          message: 'Google sign-in has not been configured for this project. Enable it once in the Firebase Console (Authentication → Sign-in method → Google) to auto-provision the OAuth client, then this tool can toggle it.',
          recoverable: false,
        },
      };
    }

    if (!checkRes.ok) {
      return {
        success: false,
        error: { code: 'PROVIDER_CONFIG_FAILED', message: `Failed to check Google config: ${checkRes.status}`, recoverable: false },
      };
    }

    const patchRes = await fetch(`${baseUrl}?updateMask=enabled`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });

    if (patchRes.status === 403) {
      return {
        success: false,
        error: { code: 'PERMISSION_DENIED', message: 'Permission denied configuring Google sign-in', recoverable: false },
      };
    }

    if (!patchRes.ok) {
      const body = await patchRes.text().catch(() => '');
      return {
        success: false,
        error: { code: 'PROVIDER_CONFIG_FAILED', message: `Failed to configure Google: ${patchRes.status} ${body}`, recoverable: false },
      };
    }

    return { success: true, provider: 'google', enabled };
  }
}
