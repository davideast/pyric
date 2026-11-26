import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export function position(fen) {
  const [placement, turn, rights, ep] = fen.split(" ");
  const board = [];
  for (const c of placement) {
    if (c === "/") continue;
    if (/^[1-8]$/.test(c)) board.push(...Array(Number(c)).fill(""));
    else board.push((c === c.toUpperCase() ? "w" : "b") + c.toLowerCase());
  }
  const enPassant = ep === "-" ? -1 : (8 - Number(ep[1])) * 8 + "abcdefgh".indexOf(ep[0]);
  return {board, turn, castling: rights === "-" ? "" : rights, enPassant};
}

function square(index) {
  return "abcdefgh"[index % 8] + (8 - Math.floor(index / 8));
}

function positionDifference(expected, actual) {
  if (!Array.isArray(actual?.board) || actual.board.length !== 64) {
    return {field: "board.length", expected: 64, actual: actual?.board?.length ?? null};
  }
  for (let i = 0; i < 64; i++) {
    if (expected.board[i] !== actual.board[i]) {
      return {field: "board." + square(i), expected: expected.board[i], actual: actual.board[i]};
    }
  }
  for (const field of ["turn", "castling", "enPassant"]) {
    if (expected[field] !== actual[field]) return {field, expected: expected[field], actual: actual[field]};
  }
}

function count(engine, pos, depth) {
  if (depth === 0) return 1;
  const moves = Array.from(engine.legalMoves(pos));
  if (depth === 1) return moves.length;
  let total = 0;
  for (const move of moves) total += count(engine, engine.apply(pos, move), depth - 1);
  return total;
}

export function score(engine, data, {includeDivides = true} = {}) {
  const counts = {
    namedPositions: data.positions.length, traces: data.traces.length, tracesReplayedFromInitial: 0, positions: 0,
    successorChecks: 0, dividedRoots: 0, deepestLeafNodes: 0, falseAccepts: 0,
    falseRefusals: 0, duplicateMoves: 0, successorMismatches: 0, outcomeMismatches: 0,
    divideMismatches: 0, mutatedInputs: 0,
  };
  let first = null;

  function snapshot(row, label, pos = position(row.fen)) {
    const moves = [...engine.legalMoves(pos)].sort();
    const missing = row.legal.filter(m => !moves.includes(m));
    const extra = moves.filter(m => !row.legal.includes(m));
    const duplicate = moves.find((m, i) => i && moves[i - 1] === m);
    counts.positions++;
    counts.falseAccepts += extra.length;
    counts.falseRefusals += missing.length;
    if (duplicate) counts.duplicateMoves++;
    if (missing.length || extra.length || duplicate) {
      first ??= {...label, fen: row.fen, field: "legalMoves", missing, extra, duplicate};
    }
    const actual = engine.outcome(pos);
    if (actual !== row.outcome) {
      counts.outcomeMismatches++;
      first ??= {...label, fen: row.fen, field: "outcome", expected: row.outcome, actual};
    }
    if (positionDifference(position(row.fen), pos)) {
      counts.mutatedInputs++;
      first ??= {...label, fen: row.fen, field: "inputPosition"};
    }
    return new Set(moves);
  }

  function successor(fen, move, expectedFen, label, legal, pos = position(fen)) {
    if (!legal.has(move)) return;
    const actual = engine.apply(pos, move);
    counts.successorChecks++;
    const diff = positionDifference(position(expectedFen), actual);
    if (diff) {
      counts.successorMismatches++;
      first ??= {...label, fen, move, ...diff};
    }
    if (positionDifference(position(fen), pos)) {
      counts.mutatedInputs++;
      first ??= {...label, fen, move, field: "inputPosition"};
    }
    if (!diff) return actual;
  }

  for (const row of data.positions) {
    const label = {case: row.name, ply: 0};
    const legal = snapshot(row, label);
    for (const [move, after] of Object.entries(row.successors)) successor(row.fen, move, after, label, legal);
    if (!includeDivides) continue;
    for (const [index, branches] of row.divides.entries()) {
      for (const [move, expected] of Object.entries(branches)) {
        const actual = legal.has(move) ? count(engine, engine.apply(position(row.fen), move), index) : 0;
        counts.dividedRoots++;
        if (index + 1 === row.divides.length) counts.deepestLeafNodes += actual;
        if (actual !== expected) {
          counts.divideMismatches++;
          first ??= {...label, fen: row.fen, move, depth: index + 1, field: "divide", expected, actual};
        }
      }
    }
  }
  for (const trace of data.traces) {
    let state = position(trace.rows[0].fen);
    let unbroken = true;
    for (const [ply, row] of trace.rows.entries()) {
      const label = {case: trace.name, ply};
      const legal = snapshot(row, label, state);
      if (row.move) {
        const nextFen = trace.rows[ply + 1].fen;
        state = successor(row.fen, row.move, nextFen, label, legal, state);
        if (!state) {
          unbroken = false;
          state = position(nextFen);
        }
      }
    }
    if (unbroken) counts.tracesReplayedFromInitial++;
  }
  return {inputDigest: data.inputDigest, counts, firstDivergence: first};
}

export function readCorpus(path) {
  const bytes = readFileSync(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const data = JSON.parse(gunzipSync(bytes));
  const publicSuite = data.inputDigest === createHash("sha256").update(readFileSync(new URL("./public.json", import.meta.url))).digest("hex");
  const pinFile = new URL(publicSuite ? "./public-corpus.sha256" : "./holdout-corpus.sha256", import.meta.url);
  if (sha !== readFileSync(pinFile, "utf8").split(/\s/)[0]) throw Error("Corpus digest mismatch");
  return data;
}

if (import.meta.main) {
  const [enginePath, ...paths] = process.argv.slice(2);
  const engine = await import(pathToFileURL(resolve(enginePath)));
  const includeDivides = !paths.includes("--skip-divides");
  const corpora = paths.filter(p => p !== "--skip-divides");
  if (!corpora.length) throw Error("Provide at least one pinned corpus");
  const results = corpora.map(p => score(engine, readCorpus(p), {includeDivides}));
  console.log(JSON.stringify({includeDivides, results}, null, 2));
  if (results.some(r => r.firstDivergence)) process.exitCode = 1;
}
