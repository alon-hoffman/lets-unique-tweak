// Tunables for a tiny game. Not a Let's Tweak file: no imports, no annotations.
export const CONFIG = {
  gravity: 1800,
  speed: 5, jumpSpeed: 5,
  maxSpeed: 1800,
  drag: -0.001,
  name: 'Skater',
  trails: true,
  accent: '#A66BFF',
  mode: 'normal',
  width: 64, thickness: 6,
} as const;

export function score(base: number) {
  const bonus = 5;
  return base * 5 + bonus - 5;
}
