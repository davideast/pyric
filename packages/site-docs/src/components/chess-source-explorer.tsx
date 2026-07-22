import rulesSource from '../examples/chess/chess-v2.rules?raw';
import { SourceExplorer, type SourceFile } from './source-explorer';

const FILES: SourceFile[] = [
  { id: 'rules', label: 'Security Rules', source: rulesSource },
];

export function ChessSourceExplorer() {
  return <SourceExplorer files={FILES} label="Chess Security Rules" />;
}
