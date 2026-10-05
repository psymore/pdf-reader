// Pure geometry helpers for annotations. Page units: viewer scale 1, y down.

export function clientToPage(clientX, clientY, rect, pageWidth, pageHeight) {
  const w = rect.width || 1;
  const h = rect.height || 1;
  return {
    x: ((clientX - rect.left) / w) * pageWidth,
    y: ((clientY - rect.top) / h) * pageHeight,
  };
}

export function mergeLineRects(rects, tolerance = 2) {
  const valid = rects.filter((r) => r.w > 0 && r.h > 0).map((r) => ({ ...r }));
  valid.sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const rect of valid) {
    const prev = out.find((o) => {
      const overlap = Math.min(o.y + o.h, rect.y + rect.h) - Math.max(o.y, rect.y);
      const sameLine = overlap > 0.5 * Math.min(o.h, rect.h);
      const gap = rect.x - (o.x + o.w);
      return sameLine && gap <= tolerance && rect.x + rect.w >= o.x - tolerance;
    });
    if (prev) {
      const left = Math.min(prev.x, rect.x);
      const top = Math.min(prev.y, rect.y);
      const right = Math.max(prev.x + prev.w, rect.x + rect.w);
      const bottom = Math.max(prev.y + prev.h, rect.y + rect.h);
      prev.x = left;
      prev.y = top;
      prev.w = right - left;
      prev.h = bottom - top;
    } else {
      out.push(rect);
    }
  }
  return out;
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function simplifyPath(points, epsilon = 0.5) {
  if (points.length < 3) return points.slice();
  let maxDistance = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = pointSegmentDistance(points[i], first, last);
    if (d > maxDistance) {
      maxDistance = d;
      index = i;
    }
  }
  if (maxDistance <= epsilon) return [first, last];
  const left = simplifyPath(points.slice(0, index + 1), epsilon);
  const right = simplifyPath(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

export const NOTE_ICON_SIZE = 24;

export function hitTestMark(mark, x, y, slop = 6) {
  if (mark.type === "highlight") {
    return mark.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
  }
  if (mark.type === "ink") {
    const reach = slop + mark.width / 2;
    const p = { x, y };
    if (mark.points.length === 1) return Math.hypot(x - mark.points[0].x, y - mark.points[0].y) <= reach;
    for (let i = 1; i < mark.points.length; i += 1) {
      if (pointSegmentDistance(p, mark.points[i - 1], mark.points[i]) <= reach) return true;
    }
    return false;
  }
  if (mark.type === "note") {
    return x >= mark.x && x <= mark.x + NOTE_ICON_SIZE && y >= mark.y && y <= mark.y + NOTE_ICON_SIZE;
  }
  return false;
}
