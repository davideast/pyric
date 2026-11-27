import {readFileSync} from 'node:fs';
export const cases = JSON.parse(readFileSync(new URL('cases.json',import.meta.url)));
export const policy = readFileSync(new URL('tally.policy',import.meta.url),'utf8');
export function moves(c) {
  return c.actions.map((kind,i) => ({kind, at:i / 10, ...(kind === 'strike' && {strength:0.65})}));
}
export function bundle(module) {
  const prefix = "rules_version = '2+modules';\n\nexport ";
  if (!module.startsWith(prefix + 'function tally(')) throw Error('expected an exported tally helper');
  const binding = readFileSync(new URL('binding.rules',import.meta.url),'utf8');
  return binding.replace('/* compiled fold */', () => module.slice(prefix.length).trimEnd());
}
