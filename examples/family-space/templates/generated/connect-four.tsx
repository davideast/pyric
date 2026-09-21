import { useState } from 'react';
import { useAppData } from '@kin/app';

const ROWS = 6;
const COLS = 7;

function Section({ title, description, actions, children }) {
  return (
    <section style={{ display: 'grid', gap: 24, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>{title}</h2>
          {description && <p style={{ margin: 0, color: '#69727e', maxWidth: '65ch', fontSize: 14 }}>{description}</p>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>{actions}</div>}
      </header>
      {children}
    </section>
  );
}

function Button({ children, variant = 'primary', busy = false, disabled = false, type = 'button', ...props }) {
  return (
    <button
      {...props}
      type={type === 'submit' ? 'button' : type} onClick={event=>{if(type==='submit'){event.preventDefault();const form=event.currentTarget.form;if(form?.reportValidity())form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}else props.onClick?.(event);}}
      className={variant === 'primary' ? 'primary' : 'secondary'}
      disabled={disabled || busy}
      aria-busy={busy}
      style={{
        minHeight: 40,
        padding: '10px 16px',
        borderRadius: 10,
        fontWeight: 500,
        cursor: disabled || busy ? 'not-allowed' : 'pointer',
        ...props.style
      }}
    >
      {children}
    </button>
  );
}

function Feedback({ kind = 'empty', title, children, actions }) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      style={{ display: 'grid', gap: 12, padding: '20px 0', borderTop: '1px solid #e7eaee', minWidth: 0 }}
    >
      <strong>{title}</strong>
      {children && <div style={{ color: '#69727e', lineHeight: 1.6, fontSize: 14 }}>{children}</div>}
      {actions && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

export default function App({ family }) {
  const { records, loading, error, setRecord, deleteRecord } = useAppData();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Setup selected players
  const [nextPlayer1Id, setPlayer1Id] = useState(family.members[0]?.id || '');
  const [nextPlayer2Id, setPlayer2Id] = useState(family.members[1]?.id || family.members[0]?.id || '');
  const currentGame=records.find(r=>r.id==='current-game');
  const activeRoundId=currentGame?.roundId??'round-1';
  const player1Id=currentGame?.player1Id??nextPlayer1Id;
  const player2Id=currentGame?.player2Id??nextPlayer2Id;

  const members = family.members || [];
  const getMemberName = (id) => members.find(m => m.id === id)?.name || id || 'Player';

  // Extract moves for active round, sorted by moveIndex
  const roundMoves = records
    .filter(r => typeof r.roundId === 'string' && r.roundId === activeRoundId && typeof r.moveIndex === 'number')
    .sort((a, b) => a.moveIndex - b.moveIndex);

  // Reconstruct board & game state
  const board = Array(ROWS).fill(null).map(() => Array(COLS).fill(null));
  let player1Symbol = 'A · Amber';
  let player2Symbol = 'B · Blue';

  let moveHistory = [];
  let winningLine = null;

  for (let i = 0; i < roundMoves.length; i++) {
    const move = roundMoves[i];
    const col = move.col;
    if (typeof col !== 'number' || col < 0 || col >= COLS) continue;

    // Find lowest empty row in this col
    let rowToFill = -1;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (!board[r][col]) {
        rowToFill = r;
        break;
      }
    }

    if (rowToFill !== -1) {
      const piece = i % 2 === 0 ? 'P1' : 'P2';
      board[rowToFill][col] = piece;
      moveHistory.push({ row: rowToFill, col, piece, recordId: move.id });
    }
  }

  // Check winner
  function checkWin(currBoard) {
    // Horizontal
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c <= COLS - 4; c++) {
        const p = currBoard[r][c];
        if (p && p === currBoard[r][c+1] && p === currBoard[r][c+2] && p === currBoard[r][c+3]) {
          return { winner: p, line: [[r,c], [r,c+1], [r,c+2], [r,c+3]] };
        }
      }
    }
    // Vertical
    for (let r = 0; r <= ROWS - 4; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = currBoard[r][c];
        if (p && p === currBoard[r+1][c] && p === currBoard[r+2][c] && p === currBoard[r+3][c]) {
          return { winner: p, line: [[r,c], [r+1,c], [r+2,c], [r+3,c]] };
        }
      }
    }
    // Diagonal down-right
    for (let r = 0; r <= ROWS - 4; r++) {
      for (let c = 0; c <= COLS - 4; c++) {
        const p = currBoard[r][c];
        if (p && p === currBoard[r+1][c+1] && p === currBoard[r+2][c+2] && p === currBoard[r+3][c+3]) {
          return { winner: p, line: [[r,c], [r+1,c+1], [r+2,c+2], [r+3,c+3]] };
        }
      }
    }
    // Diagonal up-right
    for (let r = 3; r < ROWS; r++) {
      for (let c = 0; c <= COLS - 4; c++) {
        const p = currBoard[r][c];
        if (p && p === currBoard[r-1][c+1] && p === currBoard[r-2][c+2] && p === currBoard[r-3][c+3]) {
          return { winner: p, line: [[r,c], [r-1,c+1], [r-2,c+2], [r-3,c+3]] };
        }
      }
    }
    return null;
  }

  const winResult = checkWin(board);
  const winner = winResult ? winResult.winner : null;
  winningLine = winResult ? winResult.line : null;
  const isDraw = !winner && moveHistory.length === ROWS * COLS;

  const currentTurnPlayerPiece = moveHistory.length % 2 === 0 ? 'P1' : 'P2';
  const currentTurnName = currentTurnPlayerPiece === 'P1' ? getMemberName(player1Id) : getMemberName(player2Id);

  async function handleDrop(col) {
    if (loading || saving || winner || isDraw) return;

    // Check if column is full
    if (board[0][col] !== null) return;

    setSaving(true);
    setSaveError('');
    try {
      if(!currentGame)await setRecord('current-game',{roundId:activeRoundId,player1Id,player2Id});
      const moveId = `${activeRoundId}-move-${moveHistory.length}`;
      await setRecord(moveId, {
        roundId: activeRoundId,
        moveIndex: moveHistory.length,
        col,
        player1Id,
        player2Id,
        createdAt: Date.now()
      });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleNewGame() {
    setSaving(true);
    setSaveError('');
    try {
      const newRoundId = `round-${Date.now()}`;
      // Just switch activeRoundId to a brand new one
      await setRecord('current-game',{roundId:newRoundId,player1Id:nextPlayer1Id,player2Id:nextPlayer2Id});
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleUndo() {
    if (moveHistory.length === 0 || winner || isDraw || loading || saving) return;
    const lastMove = moveHistory[moveHistory.length - 1];
    setSaving(true);
    setSaveError('');
    try {
      await deleteRecord(lastMove.recordId);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={{ padding: 20, maxWidth: 760, margin: '0 auto', display: 'grid', gap: 24, background: '#f7f8fa', color: '#1e1f20', fontFamily: 'inherit' }}>
      <Section
        title="Family Connect Four"
        description="Honor-system pass and play. Take turns dropping pieces into columns 1 through 7. Connect four in a row horizontally, vertically, or diagonally to win!"
        actions={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={handleUndo} disabled={loading || saving || moveHistory.length === 0 || !!winner || isDraw}>
              Undo Last Move
            </Button>
            <Button variant="primary" onClick={handleNewGame} busy={saving} disabled={loading}>
              New Game
            </Button>
          </div>
        }
      >
        {error || saveError ? (
          <Feedback kind="error" title="Could not complete move">
            {error || saveError}
          </Feedback>
        ) : null}

        {loading ? (
          <Feedback kind="loading" title="Loading game state…" />
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            {/* Player Setup & Turn Bar */}
            <div className="surface" style={{ padding: 16, display: 'grid', gap: 12, borderRadius: 12, background: '#ffffff', border: '1px solid #e7eaee' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'grid', gap: 4 }}>
                  <label htmlFor="p1-select" style={{ fontSize: 13, fontWeight: 500, color: '#69727e' }}>
                    🟡 Amber Player (P1)
                  </label>
                  <select
                    id="p1-select"
                    value={nextPlayer1Id}
                    onChange={(e) => setPlayer1Id(e.target.value)}
                    style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e7eaee', background: '#fff', fontSize: 14 }}
                  >
                    {members.map(m => (
                      <option key={m.id} value={m.id}>{m.name} ({m.role})</option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'grid', gap: 4 }}>
                  <label htmlFor="p2-select" style={{ fontSize: 13, fontWeight: 500, color: '#69727e' }}>
                    🔵 Blue Player (P2)
                  </label>
                  <select
                    id="p2-select"
                    value={nextPlayer2Id}
                    onChange={(e) => setPlayer2Id(e.target.value)}
                    style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e7eaee', background: '#fff', fontSize: 14 }}
                  >
                    {members.map(m => (
                      <option key={m.id} value={m.id}>{m.name} ({m.role})</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #e7eaee', paddingTop: 12, flexWrap: 'wrap', gap: 8 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>
                  {winner ? (
                    <span style={{ color: '#0659fd' }}>
                      Winner: {winner === 'P1' ? getMemberName(player1Id) : getMemberName(player2Id)} ({winner === 'P1' ? 'Amber' : 'Blue'})!
                    </span>
                  ) : isDraw ? (
                    <span style={{ color: '#69727e' }}>It's a draw! Board is full.</span>
                  ) : (
                    <span>
                      Current Turn: <strong style={{ color: currentTurnPlayerPiece === 'P1' ? '#d97706' : '#2563eb' }}>{currentTurnName} ({currentTurnPlayerPiece === 'P1' ? 'A · Amber' : 'B · Blue'})</strong>
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: '#69727e' }}>
                  One player moves at a time (Honor System)
                </div>
              </div>
            </div>

            {/* Accessible Drop Controls */}
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`, gap: 6 }}>
              {Array.from({ length: COLS }).map((_, c) => {
                const isFull = board[0][c] !== null;
                return (
                  <Button
                    key={`drop-${c}`}
                    variant="secondary"
                    onClick={() => handleDrop(c)}
                    disabled={loading || saving || !!winner || isDraw || isFull}
                    style={{ padding: '8px 4px', fontSize: 12, minHeight: 36 }}
                    aria-label={`Drop in column ${c + 1}`} title={`Drop piece in column ${c + 1}`}
                  >
                    Drop {c + 1}
                  </Button>
                );
              })}
            </div>

            {/* Game Board */}
            <div
              className="surface"
              style={{
                background: '#0659fd',
                padding: 12,
                borderRadius: 16,
                display: 'grid',
                gridTemplateRows: `repeat(${ROWS}, minmax(0, 1fr))`,
                gap: 8,
                boxShadow: '0 4px 12px rgba(6, 89, 253, 0.15)',
                minWidth: 0,
                width: '100%',
                boxSizing: 'border-box'
              }}
            >
              {board.map((row, rIdx) => (
                <div
                  key={`row-${rIdx}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
                    gap: 8
                  }}
                >
                  {row.map((cell, cIdx) => {
                    const isWinningPiece = winningLine && winningLine.some(([wr, wc]) => wr === rIdx && wc === cIdx);
                    let bg = '#ffffff';
                    let label = 'Empty slot';
                    if (cell === 'P1') {
                      bg = '#f59e0b'; // Amber
                      label = `Amber piece (${getMemberName(player1Id)})`;
                    } else if (cell === 'P2') {
                      bg = '#3b82f6'; // Blue
                      label = `Blue piece (${getMemberName(player2Id)})`;
                    }

                    return (
                      <div
                        key={`cell-${rIdx}-${cIdx}`}
                        aria-label={`Row ${rIdx + 1}, Col ${cIdx + 1}: ${label}`}
                        style={{
                          aspectRatio: '1',
                          background: bg,
                          borderRadius: '50%',
                          boxShadow: cell ? 'inset 0 2px 4px rgba(0,0,0,0.2)' : 'inset 0 2px 6px rgba(0,0,0,0.1)',
                          border: isWinningPiece ? '3px solid #ffffff' : 'none',
                          transform: isWinningPiece ? 'scale(1.05)' : 'none',
                          transition: 'transform 0.2s ease, background 0.2s ease',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
                          fontWeight: 'bold',
                          color: '#fff'
                        }}
                      >
                        {cell === 'P1' ? '🟡' : cell === 'P2' ? '🔵' : ''}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Quick Rules & State Info */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#69727e', fontSize: 13, padding: '0 4px', flexWrap: 'wrap', gap: 8 }}>
              <span>Total Moves in Round: {moveHistory.length}</span>
              <span>Active Round ID: {activeRoundId}</span>
            </div>
          </div>
        )}
      </Section>
    </main>
  );
}