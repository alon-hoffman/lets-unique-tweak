import { GRAVITY, TRAIL, BALL_COLOR, step, startVelocity } from './physics.js';
import { award, LABEL } from './scoring.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const ball = { x: 100, y: 40, vx: startVelocity(1), vy: 0 };
let score = 0;
let combo = 0;
let last = performance.now();

function frame(now) {
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;
  const before = ball.vy;
  step(ball, dt, 330);
  if (before > 0 && ball.vy < 0) { combo++; score = award(score, combo); }
  ctx.fillStyle = TRAIL ? 'rgba(24,28,58,0.18)' : '#181c3a';
  ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = BALL_COLOR;
  ctx.beginPath(); ctx.arc(ball.x, ball.y, 12, 0, 7); ctx.fill();
  document.getElementById('score').textContent = `${LABEL} ${score} (g=${GRAVITY})`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
