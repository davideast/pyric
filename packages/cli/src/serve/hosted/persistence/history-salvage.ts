import { z } from 'zod';
import type { SqlConnection } from './sqlite.js';
import { sqlText } from './sqlite.js';
import type { openHostedDatabase } from './database.js';
import type { RecoveryReport } from './salvage.js';
import { decodeHistory, encodeHistory, historyChecksum } from './history-codec.js';
import { durableUndoRecordSchema, undoAppendSchema } from './history-record.js';
/** Retain readable audit records; repaired state starts a new undo boundary. */
export function salvageHistory(input: SqlConnection, output: Awaited<ReturnType<typeof openHostedDatabase>>, report: RecoveryReport): void {
  const sourceIdentity = z.string().uuid().safeParse(input.prepare('SELECT store_id FROM history_meta WHERE id=1').get()?.store_id);
  const hasSourceIdentity = sourceIdentity.success;
  const sourceId = hasSourceIdentity ? sourceIdentity.data : null;
  const lostIdentity = sourceId === null;
  if (lostIdentity)
    report.excluded.push({ namespace: 'history-identity', id: 'store_id', reason: 'Unreadable source identity; repaired history has a new identity' });
  output.commit(() => {
    output.connection.exec("DELETE FROM history_records; DELETE FROM history_undo; DELETE FROM sqlite_sequence WHERE name='history_records'");
    const insert = output.connection.prepare('INSERT INTO history_records(sequence,session,kind,service,payload,checksum) VALUES(?,?,?,?,?,?)');
    const read = input.prepare('SELECT * FROM history_records ORDER BY sequence');
    let sequence = 0;
    for (const row of read.iterate()) {
      const next = Number(row.sequence);
      const contiguous = next === sequence + 1;
      const hasGap = !contiguous;
      if (hasGap)
        throw new Error(`History has a missing sequence after ${sequence}; preserve the original for manual recovery.`);
      sequence = next;
      try {
        output.history.decode(row);
        insert.run(sequence, sqlText(row, 'session'), sqlText(row, 'kind'), sqlText(row, 'service'), sqlText(row, 'payload'), sqlText(row, 'checksum'));
        report.recoveredHistory++;
      }
      catch {
        report.excluded.push({ namespace: 'history', id: String(sequence), reason: 'Unreadable history payload; replaced by an explicit recovery boundary' });
        const payload = encodeHistory({ reason: 'salvage-exclusion', sourceStoreId: sourceId, excludedSequence: sequence, undoUnavailableBeforeBoundary: true });
        insert.run(sequence, 'salvage', 'boundary', 'runtime', payload, historyChecksum(payload));
      }
    }
    // Undo payloads remain inspectable in the journal. Recover valid records for
    // forensic access, but never claim a recovered state matches an old cursor.
    const undo = input.prepare('SELECT * FROM history_undo ORDER BY id');
    const repairedRecord = output.connection.prepare('SELECT * FROM history_records WHERE sequence=?');
    let id = 0;
    for (const row of undo.iterate()) {
      id = Number(row.id);
      try {
        const record = repairedRecord.get(Number(row.record_sequence));
        const validRecord = record?.kind === 'undo';
        const excludedRecord = !validRecord;
        if (excludedRecord)
          throw new Error('Undo journal record was excluded during salvage');
        const entry = undoAppendSchema.parse(output.history.decode(record).payload);
        durableUndoRecordSchema.parse(decodeHistory(entry.payload, entry.checksum));
        const sameId = entry.id === id;
        const differentId = !sameId;
        if (differentId)
          throw new Error('Undo identity mismatch');
        // Detached records cannot point through an excluded or invalid link.
        output.connection.prepare('INSERT INTO history_undo VALUES(?,0,0,?)').run(id, Number(row.record_sequence));
      }
      catch {
        report.excluded.push({ namespace: 'undo', id: String(id), reason: 'Unreadable undo payload; active undo chain reset' });
      }
    }
    output.connection.prepare('UPDATE history_undo_state SET next=?,undo=0,redo=0,undo_count=0,redo_count=0 WHERE id=1').run(id + 1);
    output.connection.exec('UPDATE history_meta SET clean=1 WHERE id=1');
    output.history.record('boundary', 'runtime', { reason: 'salvage', sourceStoreId: sourceId, undoUnavailableBeforeBoundary: true, excludedRecords: report.excluded.length });
  });
}
