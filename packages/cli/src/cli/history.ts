import { historyStatusSchema, historyPageSchema } from '../serve/hosted/persistence/history-record.js';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ParsedArgs } from './parse-args.js';
import { claimProjectState } from '../serve/hosted/project-ownership.js';
import { hostedStateDirectory } from '../serve/hosted/persistence.js';
import { openHostedDatabase } from '../serve/hosted/persistence/database.js';
import { exportHistory, verifyHistoryArchive, type HistorySource } from '../serve/hosted/persistence/history-export.js';
import type { HistoryQuery } from '../serve/hosted/persistence/history.js';
const initSchema = z.object({ sessionToken: z.string(), projectKey: z.string(), hosted: z.literal(true) });
async function liveSource(port: number, project: string): Promise<HistorySource> {
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetch(`${origin}/__pyric/init.json`, { signal: AbortSignal.timeout(5000) });
  const init = initSchema.parse(await response.json());
  const sameProject = realpathSync(init.projectKey) === project;
  const wrongProject = !sameProject;
  if (wrongProject)
    throw new Error('The selected host serves a different project. Run history from that project directory.');
  async function request(query: URLSearchParams, method = 'GET'): Promise<unknown> {
    const reply = await fetch(`${origin}/__pyric/history?${query}`, { method, headers: { 'x-pyric-session-token': init.sessionToken }, signal: AbortSignal.timeout(5000) });
    const failed = !reply.ok;
    if (failed)
      throw new Error(`History request failed (${reply.status}): ${await reply.text()}`);
    return reply.json();
  }
  return {
    async status() { return historyStatusSchema.parse(await request(new URLSearchParams())); },
    async flush() { await request(new URLSearchParams({ action: 'flush' }), 'POST'); },
    async list(query: HistoryQuery) {
      const search = new URLSearchParams({ action: 'list' });
      for (const [key, value] of Object.entries(query)) {
        const defined = value !== undefined;
        if (defined)
          search.set(key, String(value));
      }
      return historyPageSchema.parse(await request(search));
    },
  };
}
/** Explicit --port attaches live; otherwise claim the project's offline store. */
export async function runHistory(parsed: ParsedArgs): Promise<number> {
  let close = () => { };
  const controller = new AbortController();
  const stop = () => { controller.abort(); };
  try {
    const action = parsed.positional[1] ?? 'status';
    const output = parsed.flags.get('out');
    const hasOutput = typeof output === 'string';
    const verifies = action === 'verify';
    if (verifies) {
      const missingOutput = !hasOutput;
      if (missingOutput)
        throw new Error('history verify requires --out <archive-directory>.');
      console.log(JSON.stringify(await verifyHistoryArchive(resolve(output)), null, 2));
      return 0;
    }
    const project = realpathSync(process.cwd());
    const port = parsed.flags.get('port');
    let source: HistorySource;
    const live = typeof port === 'string';
    if (live) {
      const number = Number(port);
      const valid = Number.isInteger(number) && number > 0 && number <= 65535;
      const invalid = !valid;
      if (invalid)
        throw new Error('Invalid --port.');
      source = await liveSource(number, project);
    }
    else {
      const owner = await claimProjectState(project);
      close = owner.close;
      const database = await openHostedDatabase(hostedStateDirectory(project), { readOnly: true });
      close = () => { try {
        database.close();
      }
      finally {
        owner.close();
      } };
      source = database.history;
    }
    switch (action) {
      case 'status':
        console.log(JSON.stringify(await source.status(), null, 2));
        break;
      case 'list': {
        const service = parsed.flags.get('service');
        const hasService = typeof service === 'string';
        const page = await source.list({ after: Number(parsed.flags.get('after') ?? 0), limit: Number(parsed.flags.get('limit') ?? 100), service: hasService ? service : undefined });
        console.log(JSON.stringify(page, null, 2));
        break;
      }
      case 'export': {
        const missingOutput = !hasOutput;
        if (missingOutput)
          throw new Error('history export requires --out <archive-directory>.');
        const watch = parsed.flags.get('watch') === true;
        const offlineWatch = watch && !live;
        if (offlineWatch)
          throw new Error('Use --port to watch a running host.');
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        const result = await exportHistory(source, output, { watch: watch ? controller.signal : undefined });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      default: throw new Error('Usage: pyric sandbox history status|list|export|verify [--port N] [--out DIR] [--watch]');
    }
    return 0;
  }
  catch (error) {
    const isError = error instanceof Error;
    console.error(isError ? error.message : String(error));
    return 1;
  }
  finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    close();
  }
}
