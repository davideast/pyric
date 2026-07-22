import { doc, getFirestore, setDoc } from 'pyric/firestore';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { inspect, seedDocuments, setRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import { resolveModulesBrowser } from 'pyric/rules/internal';
import config from './chess-v2-config.json';
import authoredRules from './chess-v2.rules?raw';
import { checkmateWinner, createChessGame, proposeMove, type ChessGame } from './run';

const resolution = resolveModulesBrowser(authoredRules);
if (!resolution.success) {
  throw new Error(`Could not resolve the chess Rules modules: ${resolution.error.message}`);
}
const rules = resolution.data.resolved;

export interface ChessVerdict {
  allowed: boolean;
  uid: 'white' | 'black';
  write: string;
  detail: string;
  checkmate: 'white' | 'black' | null;
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
        const game = gameFrom(sandbox);
        const winner = checkmateWinner(game);
        return {
          allowed: true,
          uid,
          write: `${from} → ${to}`,
          detail: winner
            ? `The Rules allowed the move. ${winner === 'white' ? 'White' : 'Black'} wins by checkmate.`
            : 'The Rules allowed the write. Firestore now contains the proposed board.',
          checkmate: winner,
        };
      } catch (error) {
        const denial = inspect(sandbox, { recentEventLimit: 1 }).events.recentDenials[0];
        return {
          allowed: false,
          uid,
          write: `${from} → ${to}`,
          detail: denial?.debugMessage
            ?? (error instanceof Error ? error.message : String(error)),
          checkmate: null,
        };
      }
    },
    reset: createChessSession,
  };
}
