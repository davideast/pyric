import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha} from '../../../arcade/corpus.mjs';
import {position} from '../../chess/reference/score.mjs';
import {legalMoves} from '../../chess/reference/native.mjs';
import {sample} from '../reference/fixtures.mjs';

const [simulator, stockRules, initialRules, revisedRules] = process.argv.slice(2);
const {firestoreRules} = await import(pathToFileURL(resolve(simulator,'dist/index.js')));
const profiles = Object.fromEntries(Object.entries({stock:stockRules, initial:initialRules, revised:revisedRules})
  .map(([name,file]) => {
    const rules = readFileSync(file,'utf8');
    return [name,{handle:firestoreRules(rules),score:{rulesSha256:sha(rules),allows:0,budgetRefusals:0,
      otherRefusals:0,peakLocalExpressions:0,firstDivergence:null}}];
  }));

function make(color,rank,from,kingRank,kingFile,density,capture) {
  const files = 'abcdefgh', to = 7-from;
  const cells = Array.from({length:8}, () => Array(8).fill('1'));
  const put = (x,y,piece) => { cells[8-y][x] = piece; };
  const own = p => color === 'w' ? p : p.toLowerCase();
  const enemy = p => color === 'b' ? p : p.toLowerCase();
  put(4,5,enemy('K'));
  put(kingFile,kingRank,own('K'));
  put(from,rank,own('R'));
  if (capture) put(to,rank,enemy('R'));
  for (const y of [3,5,6]) {
    if (y !== kingRank && (density === 2 || (density === 1 && y === 3))) put(from,y,own('P'));
  }
  const board = cells.map(row => row.join('').replace(/1+/g,empty => String(empty.length))).join('/');
  return {fen:board+' '+color+' - -',uci:files[from]+rank+files[to]+rank};
}

const positions = new Set(), scored = [];
for (const color of ['w','b']) for (const rank of [2,7]) for (const from of [0,7])
  for (const kingRank of [1,4,8]) for (const kingFile of [from,3])
    for (const density of [0,1,2]) for (const capture of [false,true]) {
      const candidate = make(color,rank,from,kingRank,kingFile,density,capture);
      const id = candidate.fen + ' ' + candidate.uci;
      assert.ok(!positions.has(id),id);
      positions.add(id);
      if (!legalMoves(position(candidate.fen)).includes(candidate.uci)) continue;
      scored.push(id);
      const {before,proposal} = sample(candidate,'writer','other');
      const write = {method:'update',description:id,path:'chess/example',resource:before,
        data:{...before,...proposal},auth:{uid:'writer'},expectation:'ALLOW'};
      for (const {handle,score} of Object.values(profiles)) {
        const [r] = handle.simulate([write]).cases;
        assert.ok(!r.unsupported, id);
        if (r.decision === 'ALLOW') score.allows++;
        else {
          if (r.resourceLimit?.kind === 'expressions') score.budgetRefusals++;
          else score.otherRefusals++;
          score.firstDivergence ??= {...candidate,localExpressions:r.evaluatedExpressions,
            diagnostic:r.resourceLimit?.message ?? 'DENY'};
        }
        score.peakLocalExpressions = Math.max(score.peakLocalExpressions,r.evaluatedExpressions);
      }
    }
console.log(JSON.stringify({authority:'native Arcade legality; local pinned Firestore evaluator',
  totalPositions:positions.size,nativeLegal:scored.length,corpusSha256:sha(JSON.stringify(scored)),
  profiles:Object.fromEntries(Object.entries(profiles).map(([key,p])=>[key,p.score]))},null,2));
