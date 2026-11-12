export const POINTS_PER_BOUNCE = 10;
export const COMBO_BONUS = 5;
export const LABEL = 'Score';

export function award(score, combo) {
  return score + POINTS_PER_BOUNCE + (combo > 2 ? COMBO_BONUS : 0);
}
