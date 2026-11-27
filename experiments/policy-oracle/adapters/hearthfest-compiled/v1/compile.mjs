import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Read the fixed two-fold form using the same expression and function-body grammar as Pyric.
const grammarSource = `Award <: FirestoreRules {
  Program = "use" "extension" "derive" ";" "use" "extension" "bounded" ";"
    "transition" ident "{" "derive" "{" Fold Fold FunctionBody "}" "require" ident "{" "return" "after" "==" "derived" ";" "}" "}"
  Fold = "let" ident "=" "bounded.fold" "(" Expr "," Expr "," "(" ident "," ident ")" "=>" "{" FunctionBody "}" "," digit+ ")" ";"
}`;
function readProgram(ohm, parser, source) {
  const grammar = ohm.grammar(grammarSource,{FirestoreRules:parser.firestoreGrammar});
  const match = grammar.match(source,'Program');
  assert.ok(match.succeeded(),match.message);
  const sem = grammar.extendSemantics(parser.firestoreSemantics);
  sem.extendOperation('toAST',{
    Program(_u,_e,_d,_s,_u2,_e2,_b,_s2,_t,_name,_lb,_derive,_lb2,lines,counts,result,_rb,_r,_req,_lb3,_ret,_a,_eq,_der,_s3,_rb2,_rb3) {
      return {lines:lines.toAST(),counts:counts.toAST(),result:result.toAST()};
    },
    Fold(_l,name,_eq,_fold,_lp,list,_c,initial,_c2,_lp2,acc,_c3,item,_rp,_arrow,_lb,body,_rb,_c4,bound,_rp2,_semi) {
      return {name:name.sourceString,list:list.toAST(),initial:initial.toAST(),acc:acc.sourceString,
        item:item.sourceString,body:body.toAST(),bound:Number(bound.sourceString)};
    }
  });
  const program = sem(match).toAST();
  // The policy language parsed these as division. Emit spaced division in a
  // deployed rules file, where a tight slash can instead introduce a path.
  function normalize(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'binaryOp' && node.op === '/') node.slashStartsPath = false;
    for (const value of Object.values(node)) normalize(value);
  }
  normalize(program);
  return program;
}

export async function compileAward(root,source,catalog,cycle) {
  const runtime = join(root,'arcade/runtime');
  const pkgFile = createRequire(join(runtime,'package.json')).resolve('@pyric/rules/package.json');
  const pkg = JSON.parse(readFileSync(pkgFile));
  const entry = name => new URL(pkg.exports[name].import,pathToFileURL(pkgFile));
  const {compilePolicy} = await import(entry('./experimental/policy'));
  const {assembleExpression:expr} = await import(entry('./internal'));
  const parser = await import(new URL('../grammar/FirestoreParser.js',entry('./experimental/policy')));
  const ohm = await import(pathToFileURL(join(runtime,'node_modules/ohm-js/index.mjs')));
  compilePolicy(source); // Also check names, extension declarations and fold limits.
  const {lines,counts,result} = readProgram(ohm,parser,source);
  assert.equal(expr(lines.list),'input.lines');
  assert.equal(expr(counts.list),'input.counts');
  assert.ok(catalog.lines.length > 0 && catalog.lines.length <= lines.bound && Number.isSafeInteger(cycle));
  assert.ok(catalog.lines.every(l=>typeof l.item === 'string' && Number.isSafeInteger(l.qty) && l.qty > 0));
  const lets = block => block.lets.map(l=>'let '+l.name+' = '+expr(l.value)+';').join('\n        ');
  const literal = v => JSON.stringify(v);
  const step = 'function awardLine('+lines.acc+', '+lines.item+') {\n        '+lets(lines.body)+'\n        return '+expr(lines.body.expr)+';\n      }';
  // Specialize the line fold to this catalog. Every count remains a database read at write time.
  let total = expr(lines.initial);
  for (const {item,qty} of catalog.lines) {
    total = 'awardLine('+total+', {"count":items.get('+literal(item)+',0),"qty":'+qty+'})';
  }

  // A boolean OR fold can short-circuit. Lower the bounded list to fixed-width
  // chunks so checking a short list never reads a missing position.
  const {body,acc,item} = counts;
  assert.equal(expr(counts.initial),'false');
  assert.ok(!body.lets.length && body.expr.type === 'binaryOp' && body.expr.op === '||'
    && body.expr.left.type === 'identifier' && body.expr.left.name === acc);
  const predicate = 'function awardCount('+item+') { return '+expr(body.expr.right)+'; }';
  const width = Math.min(8,counts.bound);
  const positions = Array.from({length:width},(_,i)=>
    '(start + '+i+' < values.size() && awardCount(values[start + '+i+']))');
  const chunk = 'function awardChunk(values,start) { return '+positions.join(' || ')+'; }';
  const chunks = Array.from({length:Math.ceil(counts.bound/width)},(_,i)=>
    '(values.size() > '+(i*width)+' && awardChunk(values,'+(i*width)+'))');
  assert.equal(result.expr.type,'mapLiteral');
  const outputs = Object.fromEntries(result.expr.entries.map(({key,value})=>[key.value,expr(value)]));
  const fields = ['points','tier','benefit'];
  for (const f of fields) assert.ok(Object.hasOwn(outputs,f));
  const check = compilePolicy('transition validateAward { require persistedAward { return '+
    fields.map(f=>'after.'+f+' == input.'+f).join(' && ')+'; } }');
  const bindings = Object.fromEntries(fields.flatMap(f=>[
    ['after.'+f,'request.resource.data.'+f],['input.'+f,'expected.'+f]]));
  const [{predicate:comparison}] = check.firestore(bindings);
  const derived = 'function scoreAward(items,input) {\n        let '+lines.name+' = '+total+';\n        let '+counts.name+
    ' = anyAwardCount(items.values());\n        '+lets(result)+'\n        return {'+
    fields.map(f=>literal(f)+': '+outputs[f]).join(', ')+'};\n      }';
  const validate = 'function validAward() {\n        let items = getAfter(/databases/$(database)/documents/hearthfest/$(cycle)/contributions/$(pid)).data.items;\n'+
    '        let expected = scoreAward(items, '+literal({benefits:catalog.benefits})+');\n'+
    '        return cycle == '+literal(String(cycle))+' && request.resource.data.pid == pid && request.resource.data.cycle == '+cycle+
    ' && items.size() <= '+counts.bound+' && request.resource.data.points is int && '+comparison+';\n      }';
  return [step,predicate,chunk,'function anyAwardCount(values) { return '+chunks.join(' || ')+'; }',derived,validate].join('\n      ');
}
