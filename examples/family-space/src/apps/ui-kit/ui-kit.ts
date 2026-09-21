/** Pure browser-local retrieval over a Firestore kit snapshot. No OPFS/cache. */
export type KitEntry = {
  id: string; version: number; purpose: string; useWhen: string; avoidWhen: string;
  tags: string[]; capabilities: string[]; dependencies: string[];
  source: string; example: string;
};
export type UiKit = { version: string; entries: KitEntry[] };
export function validateKit(kit: UiKit): UiKit {
  if (!kit || typeof kit.version !== 'string' || !Array.isArray(kit.entries) || !kit.entries.length || kit.entries.length > 30) throw new Error('UI kit is missing or invalid.');
  const ids = new Set<string>();
  for (const e of kit.entries) {
    if (!e || !/^[a-z][a-z0-9-]*$/.test(e.id) || ids.has(e.id) || !Number.isInteger(e.version) || e.version < 1 || !['purpose','useWhen','avoidWhen','source','example'].every(k => typeof e[k as keyof KitEntry] === 'string') || !['tags','capabilities','dependencies'].every(k => Array.isArray(e[k as keyof KitEntry]) && (e[k as keyof KitEntry] as unknown[]).every(v => typeof v === 'string')) || e.source.length > 20000) throw new Error('Invalid UI kit entry.');
    ids.add(e.id);
  }
  for (const e of kit.entries) if (e.dependencies.some(id => !ids.has(id))) throw new Error(`Missing dependency for ${e.id}`);
  readUi(kit, [...ids]); // Reject cycles before generation.
  return kit;
}
export function catalog(kit: UiKit) {
  return kit.entries.map(({source, example, ...metadata}) => metadata);
}
export function searchUi(kit: UiKit, needs: string[]) {
  return needs.map(need => {
    const words = need.toLowerCase().match(/[a-z]+/g) ?? [];
    const matches = kit.entries.map(e => {
      const text = [e.id,e.purpose,e.useWhen,...e.tags,...e.capabilities].join(' ').toLowerCase();
      const terms = words.filter(word => word.length > 2 && text.includes(word));
      return {id:e.id, score:terms.length, reason:terms.length ? `Matches: ${terms.join(', ')}` : ''};
    }).filter(m=>m.score>0).sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id)).slice(0,3);
    return {need,matches};
  });
}
export function readUi(kit: UiKit, ids: string[]) {
  const result: KitEntry[] = [], visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`UI kit dependency cycle: ${id}`);
    if (visited.has(id)) return;
    const entry = kit.entries.find(e=>e.id===id);
    if (!entry) throw new Error(`Unknown UI kit entry: ${id}`);
    visiting.add(id); entry.dependencies.forEach(visit); visiting.delete(id); visited.add(id); result.push(entry);
  };
  ids.forEach(visit); return result;
}
export function checkUiPlan(kit: UiKit, needs: string[], ids: string[]) {
  const selected = readUi(kit, ids);
  return searchUi(kit, needs).map(({need,matches}) => ({need, coveredBy:matches.filter(m=>selected.some(e=>e.id===m.id)).map(m=>m.id), suggestions:matches.filter(m=>!selected.some(e=>e.id===m.id)).map(m=>m.id), noMatch:!matches.length}));
}
