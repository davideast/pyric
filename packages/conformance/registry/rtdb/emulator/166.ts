import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "A production target is intentionally absent; production code continues to use `connectDatabaseEmulator` from the unchanged `firebase/database` package",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  aliases: ["rtdb#166"],
});
