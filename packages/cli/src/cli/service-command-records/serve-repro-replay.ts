import type { ServiceCommandHandler } from '../service-commands.js';
const run: ServiceCommandHandler = async parsed => {
  const { runServeReproReplay } = await import('../serve-repro.js');
  return runServeReproReplay(parsed);
};
export default run;
