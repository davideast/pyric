import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { inspect, seedDocuments, setRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import config from './chess-v2-config.json';
import rules from './chess-v2.rules?raw';
import { createChessGame, proposeMove, type ChessGame } from './run';

export interface ChessVerdict {
  allowed: boolean;
  uid: 'white' | 'black';
  write: string;
  detail: string;
}

export interface ChessSession {
  game(): ChessGame;
  move(uid: 'white' | 'black', from: string, to: string): Promise<ChessVerdict>;
  rules: string;
  lint: { errors: number; warnings: number };
  reset(): ChessSession;
}

function gameFrom(sandbox: LocalSandbox): ChessGame {
  return snapshotDocuments(sandbox)['chess-v2/demo'] as ChessGame;
}

export function createChessSession(): ChessSession {
  const sandbox = initializeSandbox();
  const lint = setRules(sandbox, rules);
  seedDocuments(sandbox, {
    'gameConfig/chessv2': config,
    'chess-v2/demo': createChessGame(),
  });

  return {
    game: () => gameFrom(sandbox),
    rules,
    lint: {
      errors: lint.warnings.filter((finding) => finding.severity === 'error').length,
      warnings: lint.warnings.filter((finding) => finding.severity === 'warning').length,
    },
    async move(uid, from, to) {
      const proposed = proposeMove(gameFrom(sandbox), from, to);
      const reference = doc(getFirestore(sandbox.withAuth({ uid })), 'chess-v2', 'demo');
      try {
        await setDoc(reference, proposed);
        return {
          allowed: true,
          uid,
          write: `${from} → ${to}`,
          detail: 'The Rules allowed the write. Firestore now contains the proposed board.',
        };
      } catch (error) {
        const denial = inspect(sandbox, { recentEventLimit: 1 }).events.recentDenials[0];
        return {
          allowed: false,
          uid,
          write: `${from} → ${to}`,
          detail: denial?.debugMessage
            ?? (error instanceof Error ? error.message : String(error)),
        };
      }
    },
    reset: createChessSession,
  };
}
