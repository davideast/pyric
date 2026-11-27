import assert from 'node:assert/strict';
import {versionNs} from '../../../arcade/corpus.mjs';

const nsPerMs = 1_000_000n;
export function captureTiming(record) {
  const rows = record.rows;
  const named = versionNs(rows['named-profile'].afterLedger.ledger.document.fields.lastChatAt.timestampValue);
  function interval(id) {
    const row = rows[id];
    if (row.decision.ledger === 'ALLOW') {
      const stamp = versionNs(row.afterLedger.ledger.document.fields.lastChatAt.timestampValue);
      assert.equal((stamp - named) % nsPerMs,0n);
      return [Number((stamp - named) / nsPerMs),Number((stamp - named) / nsPerMs)];
    }
    const lower = versionNs(row.before.ledger.readTime) - named, upper = versionNs(row.afterLedger.ledger.readTime) - named;
    assert.ok(0n <= lower && lower <= upper);
    return [Number(lower / nsPerMs), Number((upper + nsPerMs - 1n) / nsPerMs)];
  }
  const rapid = interval('rapid-repeat'), recovery = interval('after-cooldown');
  assert.ok(rapid[1] < 1500, 'rapid attempt was not proven inside the gate');
  const prior = versionNs(rows['after-cooldown'].before.ledger.document.fields.lastChatAt.timestampValue);
  assert.ok(named + BigInt(recovery[0]) * nsPerMs > prior + 1500n * nsPerMs, 'later attempt was not proven outside the gate');
  return {referenceRun:record.runId,rapid,recovery};
}
