// Middle-click autoscroll: how fast the page moves for a given cursor offset
// from the point where the middle button was pressed.

export const AUTOSCROLL_DEAD_ZONE = 12; // px around the origin that do nothing
export const AUTOSCROLL_MAX_SPEED = 8; // px/ms
const SPEED_AT_100PX = 1; // px/ms, 100px past the dead zone
const CURVE = 1.5; // >1: fine control near the origin, quick far from it

// Signed speed in px/ms along one axis; positive means the cursor is
// right of / below the origin.
export function autoscrollSpeed(offset) {
  const excess = Math.abs(offset) - AUTOSCROLL_DEAD_ZONE;
  if (excess <= 0) return 0;
  const speed = Math.min(AUTOSCROLL_MAX_SPEED, SPEED_AT_100PX * (excess / 100) ** CURVE);
  return Math.sign(offset) * speed;
}
