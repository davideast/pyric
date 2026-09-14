import { applyEdits, findNodeAtLocation, modify, parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { analyzeServiceIndex, type DatabaseIndexConfig, type DatabaseIndexQuery, type DatabaseIndexDefinition } from 'pyric/sandbox/internal';

/** Refuse duplicate keys: JSON.parse would hide an earlier security rule. */
function assertUniqueKeys(node: Node): void {
  if (node.type === 'object') {
    const names = new Set<string>();
    for (const property of node.children ?? []) {
      const name: string = property.children![0]!.value;
      if (names.has(name)) throw new Error(`Duplicate rules key ${JSON.stringify(name)}. Resolve it before adding an index.`);
      names.add(name);
    }
  }
  for (const child of node.children ?? []) assertUniqueKeys(child);
}
export function readDatabaseIndexConfig(contents: string): DatabaseIndexConfig {
  const errors: ParseError[] = [];
  const tree = parseTree(contents, errors, { allowTrailingComma: false });
  if (!tree || errors.length) throw new Error(`Fix the database rules JSON before adding an index: ${errors.map(error => printParseErrorCode(error.error)).join(', ')}`);
  assertUniqueKeys(tree);
  const rules = findNodeAtLocation(tree, ['rules']);
  if (!rules || rules.type !== 'object') throw new Error('Database rules must contain a rules object.');
  // The parser owns comment handling; the AST's offsets retain original source.
  const value = (node: Node): unknown => {
    if (node.type === 'object') return Object.fromEntries((node.children ?? []).map(property => [property.children![0]!.value, value(property.children![1]!)]));
    if (node.type === 'array') return (node.children ?? []).map(value);
    return node.value;
  };
  return { rules: value(rules) as Record<string, unknown> };
}
export function patchDatabaseIndex(contents: string, query: DatabaseIndexQuery, addition: DatabaseIndexDefinition): string {
  const config = readDatabaseIndexConfig(contents);
  const finding = analyzeServiceIndex(query, config);
  if (finding.status !== 'missing' || finding.editBlocked || !('indexOn' in finding.index) || JSON.stringify(finding.index) !== JSON.stringify(addition)) throw new Error('The database index proposal changed. Review it again.');
  const path = ['rules', ...addition.path.split('/').filter(Boolean), '.indexOn'];
  const indent = contents.match(/\n([\t ]+)"/)?.[1] ?? '  ';
  const tree = parseTree(contents)!;
  const existing = findNodeAtLocation(tree, path);
  const append = existing?.type === 'array';
  let value: string | string[] | undefined = addition.indexOn;
  if (append) value = addition.indexOn.at(-1);
  else if (addition.indexOn.length === 1) value = addition.indexOn[0];
  const edits = modify(contents, append ? [...path, -1] : path, value, {
    formattingOptions: { insertSpaces: !indent.includes('\t'), tabSize: indent.length, eol: contents.includes('\r\n') ? '\r\n' : '\n' },
  });
  const updated = applyEdits(contents, edits);
  readDatabaseIndexConfig(updated);
  return updated;
}
