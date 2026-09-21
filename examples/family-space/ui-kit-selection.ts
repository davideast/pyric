import {catalog, searchUi, readUi, checkUiPlan, type UiKit} from './ui-kit';
import {generateWithModel, type StreamingModel} from './generation-model';
export type KitSelection = { needs:string[]; ids:string[]; gaps:string[]; context:string };
export async function selectUi(kit:UiKit, prompt:string, model:StreamingModel, signal:AbortSignal, log:(title:string,detail:string)=>void):Promise<KitSelection> {
  const initial = searchUi(kit, [prompt]);
  log('search_ui', JSON.stringify(initial,null,2));
  const response = await generateWithModel(model,
    `UI_SELECTION phase. Return ONLY JSON {"needs":["interaction need"],"ids":["catalog-id"]}. Select patterns for the parent's request, including loading, errors, layout and persistent data when relevant. Do not generate TSX in this phase. Do not invent IDs.\nParent request: ${prompt}\nCatalog metadata: ${JSON.stringify(catalog(kit))}\nInitial search: ${JSON.stringify(initial)}`,
    '{}', ()=>{}, signal, undefined, 'UI_SELECTION');
  let plan: {needs:string[];ids:string[]};
  try { plan=JSON.parse(response.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'').trim()); }
  catch {throw new Error('UI planning returned invalid JSON. No app was generated. Retry the build.');}
  if (!Array.isArray(plan.needs) || !plan.needs.length || plan.needs.length>12 || !plan.needs.every(n=>typeof n==='string' && n.length<=300) || !Array.isArray(plan.ids) || plan.ids.length>15 || !plan.ids.every(id=>typeof id==='string')) throw new Error('Invalid UI plan.');
  const found = searchUi(kit,plan.needs); log('search_ui',JSON.stringify(found,null,2));
  const coverage=checkUiPlan(kit,plan.needs,plan.ids); log('check_ui_plan',JSON.stringify(coverage,null,2));
  // Include the best suggested pattern for otherwise uncovered needs.
  const ids=[...new Set([...plan.ids,...coverage.filter(c=>!c.coveredBy.length && c.suggestions.length).map(c=>c.suggestions[0])])];
  const entries=readUi(kit,ids);
  const gaps=coverage.filter(c=>c.noMatch).map(c=>c.need);
  log('read_ui',JSON.stringify({version:kit.version,entries:entries.map(e=>({id:e.id,version:e.version,dependencies:e.dependencies})),gaps},null,2));
  return {needs:plan.needs,ids:entries.map(e=>e.id),gaps,context:JSON.stringify({kitVersion:kit.version,entries,gaps})};
}
