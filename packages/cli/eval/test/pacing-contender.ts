/**
 * One of the two operating-system processes the ledger contention test spawns.
 *
 * The ledger's whole reason to exist is that two runner invocations on one
 * metered account must not each believe they hold the window, and a lock that
 * only ever sees one process cannot show that. So this is a real process: it
 * takes a ledger root, a CLI name and a number of attempts, reserves that many
 * times with `--no-wait`, and prints how many reservations it won. The test
 * adds the two counts and compares them to the budget.
 *
 * Usage: bun pacing-contender.ts <ledgerRoot> <cli> <attempts> <budget>
 */
import { Pacer } from '../pacing.js';

async function main(argv: string[]): Promise<number> {
  const [ledgerRoot, cli, attempts, budget] = argv;
  if (
    ledgerRoot === undefined ||
    cli === undefined ||
    attempts === undefined ||
    budget === undefined
  ) {
    process.stderr.write('usage: pacing-contender <ledgerRoot> <cli> <attempts> <budget>\n');
    return 2;
  }

  const pacer = new Pacer({
    minGapMs: 0,
    budgetPerWindow: Number(budget),
    ledgerRoot,
    noWait: true,
  });

  let reserved = 0;
  for (let attempt = 0; attempt < Number(attempts); attempt += 1) {
    const outcome = await pacer.reserveBudget(cli);
    if (outcome === 'ready') reserved += 1;
  }
  process.stdout.write(`${reserved}\n`);
  return 0;
}

process.exit(await main(process.argv.slice(2)));
