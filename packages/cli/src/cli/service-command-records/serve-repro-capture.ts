import type { ServiceCommandHandler } from '../service-commands.js';
const run: ServiceCommandHandler = async parsed => {
  const { runServeReproCapture } = await import('../serve-repro.js');
  return runServeReproCapture(parsed);
};
export default run;
