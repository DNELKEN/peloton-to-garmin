// A simple side-on stick figure on a rowing machine, posed for any point in the stroke.
// Kept deliberately plain so it can be swapped for a nicer illustration later: poseAt() returns
// joint positions in a 320 x 140 box and drawFigure() only moves SVG lines and circles.

const RAIL_Y = 112;
const FOOT = { x: 246, y: 102 };
const HANDLE_Y = 80;
const FLYWHEEL = { x: 288, y: 82 };
const THIGH = 56;
const SHIN = 56;
const TORSO = 54;
const UPPER_ARM = 26;
const FOREARM = 26;

// Key positions. Seat x is the hip; lean is degrees from vertical, positive toward the flywheel.
const CATCH = { seatX: 200, lean: 28, reach: 1 };
const FINISH = { seatX: 140, lean: -22, reach: 0 };

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const phaseWindow = (t, from, to) => ease((t - from) / (to - from));

// Sequence of the stroke. Drive: legs, then back, then arms. Recovery: arms, then back, then legs.
export function bodyAt(phase, t) {
  if (phase === 'drive') {
    const legs = phaseWindow(t, 0, 0.55);
    const back = phaseWindow(t, 0.3, 0.8);
    const arms = phaseWindow(t, 0.6, 1);
    return { seatX: lerp(CATCH.seatX, FINISH.seatX, legs), lean: lerp(CATCH.lean, FINISH.lean, back), reach: 1 - arms };
  }
  if (phase === 'recovery') {
    const arms = phaseWindow(t, 0, 0.25);
    const back = phaseWindow(t, 0.15, 0.45);
    const legs = phaseWindow(t, 0.4, 1);
    return { seatX: lerp(FINISH.seatX, CATCH.seatX, legs), lean: lerp(FINISH.lean, CATCH.lean, back), reach: arms };
  }
  return { ...CATCH };
}

// Two-link joint (knee or elbow) between a and b, bending to the given side (+1 or -1).
function joint(a, b, l1, l2, side) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.min(Math.hypot(dx, dy), l1 + l2 - 0.001);
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const ux = dx / (Math.hypot(dx, dy) || 1);
  const uy = dy / (Math.hypot(dx, dy) || 1);
  return { x: a.x + ux * along - side * uy * h, y: a.y + uy * along + side * ux * h };
}

export function poseAt(phase, t) {
  const { seatX, lean, reach } = bodyAt(phase, t);
  const hip = { x: seatX, y: RAIL_Y - 14 };
  const rad = (lean * Math.PI) / 180;
  const shoulder = { x: hip.x + TORSO * Math.sin(rad), y: hip.y - TORSO * Math.cos(rad) };
  const neck = { x: hip.x + (TORSO + 6) * Math.sin(rad), y: hip.y - (TORSO + 6) * Math.cos(rad) };
  const head = { x: hip.x + (TORSO + 16) * Math.sin(rad), y: hip.y - (TORSO + 16) * Math.cos(rad) };

  // Legs never reach further than the feet; at the finish they are straight.
  const knee = joint(hip, FOOT, THIGH, SHIN, -1);

  // Handle travels along the chain line. Arms straight: as far as they reach; bent: at the chest.
  const armLen = UPPER_ARM + FOREARM;
  const dy = HANDLE_Y - shoulder.y;
  const straightX = shoulder.x + Math.sqrt(Math.max(0, armLen * armLen - dy * dy)) - 1;
  const chestX = shoulder.x + 14;
  const handle = { x: Math.min(lerp(chestX, straightX, reach), FOOT.x - 6), y: HANDLE_Y };
  const elbow = joint(shoulder, handle, UPPER_ARM, FOREARM, 1);

  return { hip, knee, foot: FOOT, shoulder, neck, head, elbow, handle, seat: { x: seatX, y: RAIL_Y - 6 } };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Build the static machine and the movable body inside an <svg>; returns the parts to move.
export function createFigure(svg) {
  svg.setAttribute('viewBox', '0 0 320 140');
  const el = (tag, attrs, parent = svg) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent.appendChild(node);
    return node;
  };
  const machine = el('g', { class: 'fig-machine' });
  el('line', { x1: 40, y1: RAIL_Y, x2: 270, y2: RAIL_Y }, machine);
  el('line', { x1: 60, y1: RAIL_Y, x2: 52, y2: 128 }, machine);
  el('line', { x1: 270, y1: RAIL_Y, x2: 290, y2: 128 }, machine);
  el('circle', { cx: FLYWHEEL.x, cy: FLYWHEEL.y + 14, r: 24 }, machine);
  el('line', { x1: FOOT.x - 4, y1: FOOT.y - 18, x2: FOOT.x + 6, y2: FOOT.y + 8 }, machine);

  const body = el('g', { class: 'fig-body' });
  const parts = {
    chain: el('line', { class: 'fig-chain' }, machine),
    seat: el('rect', { width: 26, height: 6, rx: 3, class: 'fig-seat' }, machine),
    shin: el('line', {}, body),
    thigh: el('line', {}, body),
    torso: el('line', {}, body),
    upper: el('line', {}, body),
    fore: el('line', {}, body),
    head: el('circle', { r: 9 }, body),
    handle: el('circle', { r: 3, class: 'fig-handle' }, body),
  };
  return parts;
}

const setLine = (node, a, b) => {
  node.setAttribute('x1', a.x.toFixed(1));
  node.setAttribute('y1', a.y.toFixed(1));
  node.setAttribute('x2', b.x.toFixed(1));
  node.setAttribute('y2', b.y.toFixed(1));
};

export function drawFigure(parts, pose) {
  setLine(parts.chain, pose.handle, { x: FLYWHEEL.x - 14, y: FLYWHEEL.y });
  parts.seat.setAttribute('x', (pose.seat.x - 13).toFixed(1));
  parts.seat.setAttribute('y', pose.seat.y.toFixed(1));
  setLine(parts.shin, pose.knee, pose.foot);
  setLine(parts.thigh, pose.hip, pose.knee);
  setLine(parts.torso, pose.hip, pose.neck);
  setLine(parts.upper, pose.shoulder, pose.elbow);
  setLine(parts.fore, pose.elbow, pose.handle);
  parts.head.setAttribute('cx', pose.head.x.toFixed(1));
  parts.head.setAttribute('cy', pose.head.y.toFixed(1));
  parts.handle.setAttribute('cx', pose.handle.x.toFixed(1));
  parts.handle.setAttribute('cy', pose.handle.y.toFixed(1));
}
