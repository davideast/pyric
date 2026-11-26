/**
 * Yacht scoring, the classic twelve categories with no upper-section bonus:
 *
 *   ones .. sixes    the sum of the dice showing that face
 *   fullHouse        three of one face and two of another: the sum of all dice
 *                    (five of a kind is not a full house)
 *   fourKind         at least four dice of one face: the sum of those four dice
 *   littleStraight   1-2-3-4-5: 30
 *   bigStraight      2-3-4-5-6: 30
 *   choice           the sum of all dice
 *   yacht            five of a kind: 50
 *
 * A category that the dice don't satisfy scores 0. yacht.rules computes the
 * same points from the stored dice.
 */
export const CATEGORIES = [
  'ones', 'twos', 'threes', 'fours', 'fives', 'sixes',
  'fullHouse', 'fourKind', 'littleStraight', 'bigStraight', 'choice', 'yacht',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  ones: 'Ones',
  twos: 'Twos',
  threes: 'Threes',
  fours: 'Fours',
  fives: 'Fives',
  sixes: 'Sixes',
  fullHouse: 'Full House',
  fourKind: '4 of a Kind',
  littleStraight: 'L. Straight',
  bigStraight: 'B. Straight',
  choice: 'Choice',
  yacht: 'Yacht',
};

export type Dice = number[];

function count(dice: Dice, face: number): number {
  return dice.filter((d) => d === face).length;
}

function sum(dice: Dice): number {
  return dice.reduce((a, b) => a + b, 0);
}

function sameFaces(dice: Dice, faces: number[]): boolean {
  const set = new Set(dice);
  return set.size === faces.length && faces.every((f) => set.has(f));
}

export function points(category: Category, dice: Dice): number {
  const faceIndex = CATEGORIES.indexOf(category);
  if (faceIndex < 6) return (faceIndex + 1) * count(dice, faceIndex + 1);
  switch (category) {
    case 'fullHouse': {
      const c = count(dice, dice[0]);
      return new Set(dice).size === 2 && (c === 2 || c === 3) ? sum(dice) : 0;
    }
    case 'fourKind': {
      const face = [1, 2, 3, 4, 5, 6].find((f) => count(dice, f) >= 4);
      return face ? face * 4 : 0;
    }
    case 'littleStraight':
      return sameFaces(dice, [1, 2, 3, 4, 5]) ? 30 : 0;
    case 'bigStraight':
      return sameFaces(dice, [2, 3, 4, 5, 6]) ? 30 : 0;
    case 'choice':
      return sum(dice);
    case 'yacht':
      return new Set(dice).size === 1 ? 50 : 0;
    default:
      return 0;
  }
}

/** A scorecard: points per category, -1 while unused. */
export type Card = Record<Category, number>;

export function freshCard(): Card {
  return Object.fromEntries(CATEGORIES.map((c) => [c, -1])) as Card;
}

export function unused(card: Card): Category[] {
  return CATEGORIES.filter((c) => card[c] === -1);
}
