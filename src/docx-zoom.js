export const DOCX_MIN_ZOOM = 0.25;
export const DOCX_MAX_ZOOM = 4;
export const DOCX_ZOOM_STEP = 0.2;

export function clampDocxZoom(zoom) {
  return Math.min(DOCX_MAX_ZOOM, Math.max(DOCX_MIN_ZOOM, zoom));
}

export function stepDocxZoom(current, direction) {
  const factor = direction > 0 ? 1 + DOCX_ZOOM_STEP : 1 / (1 + DOCX_ZOOM_STEP);
  return clampDocxZoom(current * factor);
}

// Word pages open at their real size when they fit, and shrink to the
// screen width when they don't (phones, narrow windows) — never enlarged.
export function fitDocxZoom(availableWidth, pageWidth) {
  if (!(availableWidth > 0) || !(pageWidth > 0)) return 1;
  return clampDocxZoom(Math.min(1, availableWidth / pageWidth));
}

export function pinchDocxZoom(startZoom, startDistance, currentDistance) {
  if (!(startDistance > 0)) return clampDocxZoom(startZoom);
  return clampDocxZoom((startZoom * currentDistance) / startDistance);
}

export function scrollForZoom(scroll, anchor, previousZoom, nextZoom) {
  return Math.max(0, ((scroll + anchor) * nextZoom) / previousZoom - anchor);
}
