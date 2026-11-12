// A bouncing-ball toy. It knows nothing about Let's Tweak: plain constants, plain functions.
export const GRAVITY = 900;          // px/s^2
export const BOUNCE = 0.82;          // energy kept per bounce
export const MOVE_SPEED = 260;       // px/s sideways
export const TRAIL = true;
export const BALL_COLOR = '#6bf0ff';

export function step(ball, dt, floor) {
  ball.vy += GRAVITY * dt;
  ball.y += ball.vy * dt;
  ball.x += ball.vx * dt;
  if (ball.y > floor) { ball.y = floor; ball.vy = -ball.vy * BOUNCE; }
  if (ball.x < 0 || ball.x > 640) ball.vx = -ball.vx;
}

export function startVelocity(dir) { return dir * MOVE_SPEED; }
