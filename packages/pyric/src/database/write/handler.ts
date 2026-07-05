import { RtdbMapper } from '../mapper.js';
import type { RtdbHost } from '../host.js';
import type { RtdbIR } from '../types.js';
import type { WriteRulesResult, WriteRulesSpec } from './spec.js';

export class WriteRulesHandler implements WriteRulesSpec {
  async execute(host: RtdbHost, ir: RtdbIR): Promise<WriteRulesResult> {
    try {
      const rulesJson = RtdbMapper.mapToRulesJSON(ir);
      const token = await host.resolveAdminToken();
      const url = `${host.databaseUrl}/.settings/rules.json?access_token=${token}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rulesJson),
      });

      if (res.status === 403) {
        return {
          success: false,
          error: { code: 'PERMISSION_DENIED', message: `Permission denied: ${res.statusText}`, recoverable: false },
        };
      }

      if (res.status === 400) {
        const body = await res.text().catch(() => '');
        return {
          success: false,
          error: { code: 'INVALID_RULES_JSON', message: `Invalid rules: ${body}`, recoverable: true },
        };
      }

      if (!res.ok) {
        return {
          success: false,
          error: { code: 'WRITE_FAILED', message: `Write failed: ${res.status} ${res.statusText}`, recoverable: false },
        };
      }

      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: { code: 'WRITE_FAILED', message: e instanceof Error ? e.message : String(e), recoverable: false },
      };
    }
  }
}
