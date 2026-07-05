import { GenerateIRHandler } from './ir/handler.js';
import { SimulateHandler } from './simulation/handler.js';
import { WriteRulesHandler } from './write/handler.js';
import { CrawlStructureHandler } from './crawl/handler.js';
import { DataHandler } from './data/handler.js';
import { ValidatedWriteHandler } from './data/validated.js';
import type { RtdbIR, RtdbTools, UserAuth } from './types.js';
import type { RtdbHost } from './host.js';

type TokenResult =
  | { ok: true; token: string | undefined }
  | { ok: false; error: string };

async function resolveUserToken(host: RtdbHost, auth?: UserAuth): Promise<TokenResult> {
  if (!auth) return { ok: true, token: undefined };
  try {
    return { ok: true, token: await host.resolveUserToken(auth) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function getRtdbTools(host: RtdbHost): RtdbTools {
  let cachedIR: RtdbIR | null = null;
  const generateHandler = new GenerateIRHandler();
  const simulateHandler = new SimulateHandler();
  const writeHandler = new WriteRulesHandler();
  const crawlHandler = new CrawlStructureHandler();
  const dataHandler = new DataHandler();
  const validatedHandler = new ValidatedWriteHandler();

  const self: RtdbTools = {
    async generateIR() {
      const result = await generateHandler.execute(host);
      if (result.success) cachedIR = result.data;
      return result;
    },
    simulate(input: unknown) {
      return simulateHandler.execute(cachedIR, input);
    },
    async writeRules(ir: RtdbIR) {
      return writeHandler.execute(host, ir);
    },
    async crawlStructure(options) {
      // Crawl still uses REST (admin operation)
      const resolved = await resolveUserToken(host, options?.auth);
      if (!resolved.ok) return { success: false, error: { code: 'PERMISSION_DENIED', message: resolved.error, recoverable: false } };
      return crawlHandler.execute(host, options, resolved.token);
    },
    async readData(path, options?) {
      return dataHandler.execute(host, 'get', path, undefined, options?.auth);
    },
    async setData(path, data, options?) {
      return dataHandler.execute(host, 'set', path, data, options?.auth);
    },
    async updateData(path, data, options?) {
      return dataHandler.execute(host, 'update', path, data, options?.auth);
    },
    async pushData(path, data, options?) {
      return dataHandler.execute(host, 'push', path, data, options?.auth);
    },
    async removeData(path, options?) {
      return dataHandler.execute(host, 'remove', path, undefined, options?.auth);
    },
    async validatedWrite(input) {
      return validatedHandler.execute(host, self, input);
    },
  };

  return self;
}
