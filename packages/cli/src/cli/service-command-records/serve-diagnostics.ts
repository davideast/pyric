import type { ServiceCommandHandler } from '../service-commands.js';
const run: ServiceCommandHandler = async parsed => {
  const { runServeDiagnostics } = await import('../serve-diagnostics.js');
  return runServeDiagnostics(parsed);
};
export default run;
