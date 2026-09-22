export function computeZoom(currentZoom, deltaY, options = {}) {
  const { min = 0.25, max = 4.0, step = 0.001 } = options;
  const proposed = currentZoom - deltaY * step;
  return Math.min(max, Math.max(min, proposed));
}
