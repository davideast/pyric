import { RtdbMapper } from '../mapper.js';
import { fetchDatabase } from '../host.js';
import type { RtdbHost } from '../host.js';
import type { GenerateIRResult, GenerateIRSpec } from './spec.js';

export class GenerateIRHandler implements GenerateIRSpec {
  async execute(host: RtdbHost): Promise<GenerateIRResult> {
    try {
      const [rulesRes, shallowRes] = await Promise.all([
        fetchDatabase(host, '/.settings/rules.json'),
        fetchDatabase(host, '/.json', { shallow: 'true' }),
      ]);

      if (!rulesRes.ok) {
        return {
          success: false,
          error: {
            code: 'RULES_FETCH_FAILED',
            message: `Rules fetch failed: ${rulesRes.statusText}`,
            recoverable: false,
          },
        };
      }

      let rulesJson: unknown;
      try {
        rulesJson = await rulesRes.json();
      } catch {
        return {
          success: false,
          error: {
            code: 'RULES_PARSE_FAILED',
            message: 'Rules response is not valid JSON',
            recoverable: false,
          },
        };
      }

      const shallowData = shallowRes.ok
        ? await shallowRes.json().catch(() => null)
        : null;

      const ir = RtdbMapper.mapToIR(rulesJson, shallowData, host.databaseUrl);
      return { success: true, data: ir };
    } catch (e) {
      return {
        success: false,
        error: {
          code: 'INVALID_RULES_JSON',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        },
      };
    }
  }
}
