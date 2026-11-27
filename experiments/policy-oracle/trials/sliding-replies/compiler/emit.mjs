import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {loadPolicyApi} from '../../king-safety/policy/public-api.mjs';
import {sources, binding} from './sources.mjs';

const baseline = new URL('../../chess-safety/artefacts/knight-endgame-paired-pawn-combined-bare-fixed-comma-packed-v5.rules', import.meta.url);
const digest = text => createHash('sha256').update(text).digest('hex');

export function link(compiled, variant) {
  let rules = readFileSync(baseline, 'utf8');
  assert.equal(digest(rules), '5365dc5183a2ef4d8a9af8443e4d35323fd7a4794e602c7a6fff36220a7e8380');
  const functions = [];
  for (const [name, module] of Object.entries(compiled)) {
    const text = module.replace(/^rules_version\s*=\s*'2\+modules';\s*/, '').trim();
    assert.ok(text.startsWith('export function ' + name + '(') && text.endsWith('}'), name);
    functions.push(text.slice('export '.length));
  }
  functions.push(binding(variant));
  const name = '  function admittedStatus(';
  assert.equal(rules.split(name).length, 2);
  rules = rules.replace(name, () => '  ' + functions.join('\n  ') + '\n' + name);
  const original = "let defender = white ? 'b' : 'w';\n    return status == 'playing' ?";
  assert.equal(rules.split(original).length, 2);
  const fallback = "let defender = white ? 'b' : 'w';\n    return (white ? sliderMaterialb(text) : sliderMaterialw(text)) ? sliderStatus(text,defender,status) : status == 'playing' ?";
  return rules.replace(original, () => fallback);
}

export function emit(compileFunction, variant) {
  const source = sources(variant);
  const modules = Object.fromEntries(Object.entries(source).map(([name,text]) => [name,compileFunction(text).firestoreModule()]));
  return {rules:link(modules, variant), modules, source};
}

if (import.meta.main) {
  const [pkg, output, variant] = process.argv.slice(2);
  if (!pkg || !output || !variant) throw Error('Usage: bun emit.mjs INSTALLED_PACKAGE COMPLETE_RULES VARIANT');
  const {compileFunction} = await loadPolicyApi(pkg);
  const {rules, modules} = emit(compileFunction, variant);
  writeFileSync(output, rules);
  console.log(JSON.stringify({variant, sha256:digest(rules), bytes:Buffer.byteLength(rules), functions:Object.keys(modules)}));
}
