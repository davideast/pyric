import type { ServiceCommandHandler } from '../service-commands.js';
const run: ServiceCommandHandler = async parsed => {
  const { runServeDenials } = await import('../serve-denials.js');
  return runServeDenials(parsed);
};
export default run;
