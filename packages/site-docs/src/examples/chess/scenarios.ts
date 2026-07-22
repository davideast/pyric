export type ChessPlayer = 'white' | 'black';

export interface ChessScenarioMove {
  player: ChessPlayer;
  from: string;
  to: string;
}

export interface ChessScenario {
  id: 'fools-mate' | 'scholars-mate' | 'ruy-lopez' | 'illegal-pawn-leap';
  label: string;
  description: string;
  moves: readonly ChessScenarioMove[];
  expected: {
    allowed: boolean;
    winner: ChessPlayer | null;
  };
}

export const CHESS_SCENARIOS = [
  {
    id: 'fools-mate',
    label: 'Fool’s Mate',
    description: 'Black checkmates White in four moves.',
    moves: [
      { player: 'white', from: 'f2', to: 'f3' },
      { player: 'black', from: 'e7', to: 'e5' },
      { player: 'white', from: 'g2', to: 'g4' },
      { player: 'black', from: 'd8', to: 'h4' },
    ],
    expected: { allowed: true, winner: 'black' },
  },
  {
    id: 'scholars-mate',
    label: 'Scholar’s Mate',
    description: 'White checkmates Black in seven moves.',
    moves: [
      { player: 'white', from: 'e2', to: 'e4' },
      { player: 'black', from: 'e7', to: 'e5' },
      { player: 'white', from: 'f1', to: 'c4' },
      { player: 'black', from: 'b8', to: 'c6' },
      { player: 'white', from: 'd1', to: 'h5' },
      { player: 'black', from: 'g8', to: 'f6' },
      { player: 'white', from: 'h5', to: 'f7' },
    ],
    expected: { allowed: true, winner: 'white' },
  },
  {
    id: 'ruy-lopez',
    label: 'Ruy López opening',
    description: 'Five legal moves leave the game in progress.',
    moves: [
      { player: 'white', from: 'e2', to: 'e4' },
      { player: 'black', from: 'e7', to: 'e5' },
      { player: 'white', from: 'g1', to: 'f3' },
      { player: 'black', from: 'b8', to: 'c6' },
      { player: 'white', from: 'f1', to: 'b5' },
    ],
    expected: { allowed: true, winner: null },
  },
  {
    id: 'illegal-pawn-leap',
    label: 'Illegal pawn leap',
    description: 'White tries e2 → e5, and the Rules deny the write.',
    moves: [
      { player: 'white', from: 'e2', to: 'e5' },
    ],
    expected: { allowed: false, winner: null },
  },
] as const satisfies readonly ChessScenario[];

export type ChessScenarioId = typeof CHESS_SCENARIOS[number]['id'];

export function chessScenario(id: ChessScenarioId): ChessScenario {
  const scenario = CHESS_SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Unknown chess scenario: ${id}`);
  return scenario;
}

export function scenarioMoves(scenario: ChessScenario): string {
  return scenario.moves.map(({ from, to }) => `${from} → ${to}`).join(', ');
}
