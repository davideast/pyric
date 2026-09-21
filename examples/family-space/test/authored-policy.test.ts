import 'fake-indexeddb/auto';
import { test, expect } from 'bun:test';
import { createGenerationPolicyTools } from '../generation-policy-tools';
import { checkPolicy, policyCase, policyFixtures, validatePolicy } from '../app-policy';
import { noteSource, note, noteCases } from "./authored-policy-fixture";
test('authored owner-only notes pass both engines and enforce writes after artifact serialization', async () => {
 const tools = createGenerationPolicyTools();
 expect(await tools.call('app_policy_prepare',{source:noteSource,summary:'Members manage only their own notes.',cases:noteCases})).toMatchObject({ok:true});
 expect(() => tools.selection()).toThrow();
 expect(await tools.call('app_policy_test',{})).toMatchObject({ok:true});
 const selected = tools.selection();
 const policy = JSON.parse(JSON.stringify(selected.policy));
 expect(policy.format).toBe(2);
 expect(selected.validation!.passed).toBeGreaterThan(noteCases.length);
 expect(selected.validation!.sandboxPassed).toBe(selected.validation!.passed);
 const {members} = policyFixtures();
 expect(() => checkPolicy(policy,policyCase('update','sam',members,note,{...note,text:'New'}))).not.toThrow();
 expect(() => checkPolicy(policy,policyCase('update','zoe',members,note,{...note,text:'New'}))).toThrow();
 expect(() => checkPolicy(policy,policyCase('create',null,members,undefined,note))).toThrow();
 await expect(validatePolicy(policy,[{id:'saved',...note}],members)).resolves.toBeDefined();
 await expect(validatePolicy(policy,[{id:'bad',owner:'missing',text:'Old'}],members)).rejects.toThrow('incompatible');
});
test('host refuses unsafe policies and clears evidence when a new candidate fails', async () => {
 const tools = createGenerationPolicyTools();
 await tools.call('app_policy_prepare',{source:noteSource,summary:'Own notes',cases:noteCases});
 await tools.call('app_policy_test',{});
 expect((await tools.call('app_policy_prepare',{source:noteSource.replace('allow create: if member() && ', 'allow create: if '),summary:'Unsafe',cases:noteCases})).ok).toBe(true);
 expect((await tools.call('app_policy_test',{})).ok).toBe(false);
 expect(() => tools.selection()).toThrow();
 for (const source of [
  noteSource.replace('members/$(request.auth.uid)','secrets/$(request.auth.uid)'),
  noteSource.replace('exists(', 'getAfter('),
  noteSource.replace('records/{record}', '{document=**}'),
 ]) expect((await tools.call('app_policy_prepare',{source,summary:'Unsupported',cases:noteCases})).ok).toBe(false);
 expect((await tools.call('app_policy_prepare',{source:noteSource,summary:'Missing tests',cases:[]})).ok).toBe(false);
});
test('authored policies resolve declared membership fields and reject tampered artifacts', async () => {
 const source = noteSource.replace('allow create: if member() &&', 'allow create: if exists(/databases/$(database)/documents/families/$(family)/members/$(request.resource.data.recipient)) && member() &&');
 const cases = noteCases.map(c => c.after ? {...c,after:{...c.after,recipient:'zoe'}} : c);
 const tools = createGenerationPolicyTools();
 expect((await tools.call('app_policy_prepare',{source,summary:'Owned notes sent to family members',cases})).ok).toBe(true);
 expect((await tools.call('app_policy_test',{})).ok).toBe(true);
 const policy = tools.selection().policy!;
 const {members} = policyFixtures();
 expect(() => checkPolicy(policy,policyCase('create','sam',members,undefined,{...note,recipient:'zoe'}))).not.toThrow();
 expect(() => checkPolicy(policy,policyCase('create','sam',members,undefined,{...note,recipient:'outsider'}))).toThrow();
 expect(() => checkPolicy({...policy,resolved:noteSource},policyCase('create','sam',members,undefined,note))).toThrow();
});
test('JSON null for an absent before/after document does not block policy preparation', async () => {
 const tools = createGenerationPolicyTools();
 const cases = noteCases.map(c=>({...c,...(c.method==='create'?{before:null}:{}),...(c.method==='delete'?{after:null}:{})}));
 expect(await tools.call('app_policy_prepare',{source:noteSource,summary:'Own notes',cases})).toMatchObject({ok:true});
});
test('policy-case errors identify the precise case and field for repair', async () => {
 const tools = createGenerationPolicyTools();
 const cases = noteCases.map((c,i)=>i===1?{...c,method:'outsider'}:c);
 const result = await tools.call('app_policy_prepare',{source:noteSource,summary:'Own notes',cases});
 expect(result.ok).toBe(false);
 expect(result.error).toContain('cases[1].method');
 expect(result.error).toContain('create, update, delete');
});
test('rules and case batches can be prepared separately without selecting an untested candidate', async () => {
 const tools = createGenerationPolicyTools();
 expect(await tools.call('app_policy_prepare',{source:noteSource,summary:'Own notes'})).toMatchObject({ok:true});
 expect(() => tools.selection()).toThrow();
 expect((await tools.call('app_policy_test',{})).ok).toBe(false);
 expect((await tools.call('app_policy_cases',{cases:noteCases.slice(0,3)})).ok).toBe(true);
 expect((await tools.call('app_policy_cases',{cases:noteCases.slice(3),mode:'append'})).ok).toBe(true);
 expect((await tools.call('app_policy_test',{})).ok).toBe(true);
 expect(tools.selection().validation?.passed).toBeGreaterThan(6);
 expect((await tools.call('app_policy_cases',{cases:[{method:'outsider'}]})).ok).toBe(false);
 expect(() => tools.selection()).toThrow();
});
