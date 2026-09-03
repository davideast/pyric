/**
 * Game Primitives — Typed Service Contracts
 *
 * Each primitive generates a validate or write expression for turn-based
 * game logic. These encode the correct data/newData context by construction.
 */

export const GAME_SPECS = {
  turnGuardWithStatus: {
    args: { turnField: 'currentTurn', players: { X: 'playerX', O: 'playerO' }, statusField: 'status', playingValue: 'playing' },
    output: '(data.child("status").val() == "playing") && (data.child("currentTurn").val() == "X" && data.child("playerX").val() == auth.uid || data.child("currentTurn").val() == "O" && data.child("playerO").val() == auth.uid)',
  },
  turnGuardNoStatus: {
    args: { turnField: 'currentTurn', players: { X: 'playerX', O: 'playerO' } },
    output: 'data.child("currentTurn").val() == "X" && data.child("playerX").val() == auth.uid || data.child("currentTurn").val() == "O" && data.child("playerO").val() == auth.uid',
  },
  flipTwoMarks: {
    args: { marks: ['X', 'O'] },
    output: '((!(data.exists())) && (newData.val() == "X")) || ((data.val() == "X") && (newData.val() == "O")) || ((data.val() == "O") && (newData.val() == "X"))',
  },
  flipThreeMarks: {
    args: { marks: ['A', 'B', 'C'] },
    output: '((!(data.exists())) && (newData.val() == "A")) || ((data.val() == "A") && (newData.val() == "B")) || ((data.val() == "B") && (newData.val() == "C")) || ((data.val() == "C") && (newData.val() == "A"))',
  },
  winCheckHelper: {
    args: { mark: 'X', lines: [[0,1,2],[3,4,5]], boardPath: 'board' },
    checks: {
      includesAll: ['newData.isBoolean()', 'board/0', 'board/1', 'board/2', 'board/3', 'board/4', 'board/5'],
      parsesValid: true,
    },
  },
} as const;
