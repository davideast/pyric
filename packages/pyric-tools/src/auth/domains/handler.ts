import type { ProjectScope } from '@pyric/cli/deploy';
import type { ManageDomainsInput, ManageDomainsResult } from './spec.js';

export class ManageDomainsHandler {
  async execute(scope: ProjectScope, input: ManageDomainsInput): Promise<ManageDomainsResult> {
    try {
      const token = await scope.resolveToken();
      const configUrl = `https://identitytoolkit.googleapis.com/admin/v2/projects/${scope.projectId}/config`;

      // Read current config to get authorized domains
      const getRes = await fetch(configUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (getRes.status === 403) {
        return {
          success: false,
          error: { code: 'PERMISSION_DENIED', message: 'Permission denied reading auth config', recoverable: false },
        };
      }

      if (!getRes.ok) {
        return {
          success: false,
          error: { code: 'DOMAIN_CONFIG_FAILED', message: `Failed to read config: ${getRes.status}`, recoverable: false },
        };
      }

      const config = await getRes.json() as { authorizedDomains?: string[] };
      const domains = config.authorizedDomains || [];

      if (input.action === 'list') {
        return { success: true, authorizedDomains: domains };
      }

      if (!input.domain || input.domain.trim() === '') {
        return {
          success: false,
          error: { code: 'INVALID_DOMAIN', message: 'Domain is required for add/remove actions', recoverable: true },
        };
      }

      const domain = input.domain.trim();
      let warning: string | undefined;

      if (input.action === 'add') {
        if (domains.includes(domain)) {
          return { success: true, authorizedDomains: domains };
        }
        domains.push(domain);
      } else {
        // remove
        if (!domains.includes(domain)) {
          return { success: true, authorizedDomains: domains };
        }
        if (domain === 'localhost') {
          warning = 'Removing localhost may break local development. Re-add it with action: "add" if needed.';
        }
        const idx = domains.indexOf(domain);
        domains.splice(idx, 1);
      }

      // Write updated domains
      const patchRes = await fetch(`${configUrl}?updateMask=authorizedDomains`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorizedDomains: domains }),
      });

      if (!patchRes.ok) {
        const body = await patchRes.text().catch(() => '');
        return {
          success: false,
          error: { code: 'DOMAIN_CONFIG_FAILED', message: `Failed to update domains: ${patchRes.status} ${body}`, recoverable: false },
        };
      }

      return { success: true, authorizedDomains: domains, warning };
    } catch (e) {
      return {
        success: false,
        error: { code: 'DOMAIN_CONFIG_FAILED', message: e instanceof Error ? e.message : String(e), recoverable: false },
      };
    }
  }
}
