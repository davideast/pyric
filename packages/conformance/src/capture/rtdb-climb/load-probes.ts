import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

interface ProbeRecordModule {
  createProbe(ctx: RtdbClimbContext): RtdbClimbProbe;
}

/**
 * Load authored RTDB climb probe records from this directory.
 *
 * The filename is the stable join key and directory discovery is the index;
 * adding a probe never requires editing a shared source list.
 */
export async function loadRtdbClimbProbes(
  ctx: RtdbClimbContext,
): Promise<RtdbClimbProbe[]> {
  const filenames = (await readdir(import.meta.dir))
    .filter((filename) => filename.endsWith('.probe.ts'))
    .sort();
  const probes = await Promise.all(filenames.map(async (filename) => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, filename)).href;
    const record = await import(moduleUrl) as ProbeRecordModule;
    return record.createProbe(ctx);
  }));
  const names = new Set<string>();
  for (const probe of probes) {
    if (names.has(probe.name)) {
      throw new Error(`duplicate RTDB climb probe name: ${probe.name}`);
    }
    names.add(probe.name);
  }
  return probes;
}
