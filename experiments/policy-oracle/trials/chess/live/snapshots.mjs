import assert from 'node:assert/strict';
import { dbName } from '../../../arcade/live/control.mjs';
import { lite, readDocument } from '../../../arcade/live/controller/clients.mjs';
import { versionNs } from '../../../arcade/corpus.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export const json = value => JSON.parse(JSON.stringify(value));
export async function decision(fn) {
  try { await fn(); return 'ALLOW'; }
  catch (err) { if (err.code === 'permission-denied') return 'DENY'; throw err; }
}
export function unpack(fields) {
  function value(v) {
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(value);
    if ('mapValue' in v) return unpack(v.mapValue.fields || {});
    if ('timestampValue' in v) {
      const ns = versionNs(v.timestampValue);
      return {type: 'firestore/timestamp/1.0', seconds: Number(ns / 1000000000n), nanoseconds: Number(ns % 1000000000n)};
    }
    throw new Error('Unexpected match field type');
  }
  return Object.fromEntries(Object.entries(fields).map(([key, v]) => [key, value(v)]));
}
export async function snapshot(reader, path) {
  let signed;
  for (let attempt = 0; ; attempt++) {
    try { signed = await lite.getDoc(lite.doc(reader.lite, path)); break; }
    catch (e) {
      if (!['permission-denied','unavailable','deadline-exceeded'].includes(e.code) || attempt >= 10) throw e;
      console.log('Retry server read',path,e.code,attempt+1);
      await delay(4000);
    }
  }
  const data = signed.exists() ? json(signed.data()) : null;
  let wire;
  try { wire = await readDocument(path); }
  catch (e) {
    if (e.message.endsWith(' 404 NOT_FOUND') && data === null) return {path, data, version: null};
    throw e;
  }
  assert.equal(wire.name, dbName + '/documents/' + path);
  assert.deepEqual(data, unpack(wire.fields));
  return {path, data, version: wire.updateTime, created: wire.createTime};
}
export const square = i => 'abcdefgh'[i % 8] + (8 - Math.floor(i / 8));
export const index = s => (8 - Number(s[1])) * 8 + 'abcdefgh'.indexOf(s[0]);
export const move = uci => ({from: index(uci.slice(0, 2)), to: index(uci.slice(2, 4)), ...(uci[4] && {promotion: uci[4]})});

export function fromPolicy(engine, matchPolicy, doc, uci) {
  const names = Array.from({length: 64}, (_, i) => square(i));
  const position = {board: names.map(s => doc.board[s]), turn: doc.currentTurn === 'host' ? 'w' : 'b',
    enPassant: doc.enPassant ? index(doc.enPassant) : -1, castling: doc.castling};
  if (!engine.legalMoves(position).includes(uci)) return null;
  const next = engine.apply(position, uci);
  const result = engine.outcome(next);
  const board = Object.fromEntries(names.map((s, i) => [s, next.board[i]]));
  return {board, prevBoard:doc.board, ...matchPolicy.metadata(doc,uci,position,next,result)};
}
