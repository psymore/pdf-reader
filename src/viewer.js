import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
import { computeZoom } from "./zoom.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";

const container = document.getElementById("viewer-container");
const pagesWrapper = document.getElementById("pdf-pages");

const MAX_ZOOM = 4.0;
const RESIZE_SETTLE_DELAY = 150;
const ZOOM_RERENDER_DELAY = 120;

let pdfDoc = null;

// zoomLevel/panX/panY are the single source of truth for what's on screen;
// everything else (renderedZoom, the actual canvas pixels) exists purely to
// make that view crisp and is free to lag behind during a gesture. Pan is
// tracked independently of render resolution: a content point at native
// (scale-1) position `p` always appears on screen at `panX + p * zoomLevel`,
// regardless of what resolution the canvases actually happen to be rendered
// at right now (see applyTransform). This is what lets panning skip
// re-rendering entirely, and lets pan/zoom math stay simple and exact
// instead of accumulating drift across gestures.
let zoomLevel = 1;
let panX = 0;
let panY = 0;

let renderedZoom = 1; // zoom level the current canvases are actually rasterized at
// The on-screen size of #pdf-pages immediately after the last real render,
// i.e. at scale (zoomLevel / renderedZoom) == 1. Combined with that ratio,
// this gives the exact current on-screen content size at any zoomLevel,
// even mid-gesture — see contentSize().
let renderedContentWidth = 0;
let renderedContentHeight = 0;

// The most zoomed-out a document is allowed to get — its fit-width zoom.
// There's no reset button: pinching/scrolling all the way out to this floor
// *is* the reset gesture, so it doubles as "the default view".
let minZoom = 0.25;

let renderGeneration = 0;
let statusCallback = null;
let zoomDebounceTimer = null;
let resizeDebounceTimer = null;

export function setStatusCallback(fn) {
  statusCallback = fn;
}

function reportError(message) {
  if (statusCallback) {
    statusCallback(message);
  }
}

// The exact current on-screen size of the content, at whatever zoomLevel is
// right now — exact (not approximate) because it's derived from the same
// scale factor the CSS transform itself applies, not re-measured from a
// possibly-stale DOM layout.
function contentSize() {
  const s = renderedZoom > 0 ? zoomLevel / renderedZoom : 1;
  return { width: renderedContentWidth * s, height: renderedContentHeight * s };
}

// Keeps panX/panY within bounds where the content can never be dragged
// further than flush with the container edge: centered (with no slack to
// drag at all) on any axis where it's smaller than the viewport, clamped to
// [viewport - content, 0] on any axis where it overflows. This makes "the
// page ends up with dead space beside/below it" structurally impossible
// rather than something that happens to fall out of the browser's own
// scroll/overflow behavior.
function clampPan() {
  const { width, height } = contentSize();
  const w = container.clientWidth;
  const h = container.clientHeight;
  panX = width <= w ? (w - width) / 2 : Math.min(0, Math.max(w - width, panX));
  panY = height <= h ? (h - height) / 2 : Math.min(0, Math.max(h - height, panY));
}

function applyTransform() {
  const s = renderedZoom > 0 ? zoomLevel / renderedZoom : 1;
  pagesWrapper.style.transformOrigin = "0 0";
  pagesWrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${s})`;
}

// Applies a live view update (from any gesture): clamp, paint, and — if the
// zoom actually changed — queue a real re-render so the canvases eventually
// catch up in resolution. Pure panning never needs a re-render at all.
function updateView({ rerender = false } = {}) {
  clampPan();
  applyTransform();
  if (rerender) scheduleRerender();
}

function scheduleRerender(delay = ZOOM_RERENDER_DELAY) {
  clearTimeout(zoomDebounceTimer);
  zoomDebounceTimer = setTimeout(() => {
    rerenderAllPages().catch((err) => {
      reportError(`Could not render PDF: ${err.message || err}`);
    });
  }, delay);
}

function containerRelativePoint(clientX, clientY) {
  const rect = container.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

// Applies a zoom change anchored at a screen point: the content point
// currently under that point stays under it. `newZoom` may get clamped
// inside updateView via clampPan, but the anchor math itself is exact for
// whatever zoom is actually applied.
function zoomAt(anchor, newZoom) {
  const clamped = Math.min(MAX_ZOOM, Math.max(minZoom, newZoom));
  const contentX = (anchor.x - panX) / zoomLevel;
  const contentY = (anchor.y - panY) / zoomLevel;
  zoomLevel = clamped;
  panX = anchor.x - contentX * zoomLevel;
  panY = anchor.y - contentY * zoomLevel;
  updateView({ rerender: true });
}

container.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (!pdfDoc) return;
    if (event.ctrlKey) {
      const anchor = containerRelativePoint(event.clientX, event.clientY);
      zoomAt(anchor, computeZoom(zoomLevel, event.deltaY, { min: minZoom, max: MAX_ZOOM }));
    } else {
      // Plain (or trackpad two-finger) scroll pans instead of zooming —
      // there's no native scroll to fall back on, since panning is what
      // drives reading down through the document now.
      panX -= event.deltaX;
      panY -= event.deltaY;
      updateView();
    }
  },
  { passive: false }
);

// Single-finger drag pans; two-finger pinch zooms (anchored at the pinch
// midpoint) *and* pans by however much that midpoint itself moves, so the
// gesture feels like grabbing the page rather than zooming in place. Every
// touchmove only updates the (cheap) transform — the real, crisp re-render
// happens once, when the gesture actually ends (see endGesture), the same
// two-phase way most PDF/document viewers (e.g. WPS) do it. Re-rendering
// mid-gesture instead (this app used to) meant a brief pause mid-gesture
// would trigger a real render and snap the view, which read as
// quirky/uncontrolled rather than smooth.
let gesture = null; // { pointers: Map<id, {x,y}>, startPanX, startPanY, startZoom, startMid, startDistance }

function touchPoint(touch) {
  return containerRelativePoint(touch.clientX, touch.clientY);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function beginGesture(touches) {
  if (touches.length === 1) {
    gesture = { kind: "pan", start: touchPoint(touches[0]), startPanX: panX, startPanY: panY };
  } else if (touches.length === 2) {
    const p0 = touchPoint(touches[0]);
    const p1 = touchPoint(touches[1]);
    gesture = {
      kind: "pinch",
      startMid: midpoint(p0, p1),
      startDistance: distance(p0, p1),
      startZoom: zoomLevel,
      startPanX: panX,
      startPanY: panY,
    };
  } else {
    gesture = null;
  }
}

container.addEventListener(
  "touchstart",
  (event) => {
    if (!pdfDoc) return;
    beginGesture(event.touches);
  },
  { passive: true }
);

container.addEventListener(
  "touchmove",
  (event) => {
    if (!gesture || !pdfDoc) return;
    // Not passive, and explicitly prevented: some WebViews still attempt
    // their own native pan/zoom handling alongside ours otherwise, and the
    // two competing for the same touch stream is what made gestures feel
    // stepped/laggy instead of tracking fingers directly.
    event.preventDefault();

    if (gesture.kind === "pan" && event.touches.length === 1) {
      const p = touchPoint(event.touches[0]);
      panX = gesture.startPanX + (p.x - gesture.start.x);
      panY = gesture.startPanY + (p.y - gesture.start.y);
      updateView();
    } else if (gesture.kind === "pinch" && event.touches.length === 2) {
      const p0 = touchPoint(event.touches[0]);
      const p1 = touchPoint(event.touches[1]);
      const mid = midpoint(p0, p1);
      const scale = distance(p0, p1) / gesture.startDistance;
      const newZoom = Math.min(MAX_ZOOM, Math.max(minZoom, gesture.startZoom * scale));
      // Anchored on the *gesture's* start point/zoom (not incrementally on
      // the previous frame), so there's no drift accumulating over a long,
      // jittery pinch — this is always computed fresh from a fixed origin.
      const contentX = (gesture.startMid.x - gesture.startPanX) / gesture.startZoom;
      const contentY = (gesture.startMid.y - gesture.startPanY) / gesture.startZoom;
      zoomLevel = newZoom;
      panX = mid.x - contentX * newZoom;
      panY = mid.y - contentY * newZoom;
      updateView();
    } else {
      // Finger count changed mid-gesture (e.g. lifted one of two) — restart
      // cleanly from the current touch list rather than trying to patch it.
      beginGesture(event.touches);
    }
  },
  { passive: false }
);

function commitZoom() {
  clearTimeout(zoomDebounceTimer);
  rerenderAllPages().catch((err) => {
    reportError(`Could not render PDF: ${err.message || err}`);
  });
}

container.addEventListener("touchend", (event) => {
  // Two fingers lifted after a pinch fire touchend one at a time, not
  // simultaneously — by the time the *first* touchend arrives, touches.length
  // is already 1, so this transition is "still a finger down" just as often
  // as it's "gesture fully over". Committing the crisp render here whenever
  // a pinch was in progress (regardless of which branch runs next) is what
  // makes sure it isn't silently skipped by falling into the pan branch.
  const wasZooming = gesture?.kind === "pinch";
  if (event.touches.length === 0) {
    gesture = null;
  } else {
    beginGesture(event.touches); // e.g. pinch -> still one finger down: switch to pan
  }
  if (wasZooming) commitZoom();
});
container.addEventListener("touchcancel", () => {
  const wasZooming = gesture?.kind === "pinch";
  gesture = null;
  if (wasZooming) commitZoom();
});

window.addEventListener("resize", () => {
  clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = setTimeout(() => {
    if (!pdfDoc) return;
    computeFitZoom().then((fitZoom) => {
      minZoom = fitZoom;
      // A resize (e.g. rotating the phone) can leave the old zoom below the
      // new fit floor — without re-snapping, the page would end up smaller
      // than the viewport with dead space beside it, exactly the bug this
      // whole pan/zoom model exists to make impossible.
      if (zoomLevel < minZoom) zoomLevel = minZoom;
      updateView({ rerender: true });
    });
  }, RESIZE_SETTLE_DELAY);
});

async function computeFitZoom() {
  const page = await pdfDoc.getPage(1);
  const nativeWidth = page.getViewport({ scale: 1 }).width;
  // container.clientWidth already excludes whatever the platform actually
  // reserves for its scrollbar (which varies — desktop reserves the custom
  // 16px track, Android's overlay scrollbar reserves none), so it's the
  // exact space a page has to fill with zero left/right margin. This only
  // reads correctly once the caller has unhidden the container.
  const availableWidth = container.clientWidth;
  if (availableWidth <= 0 || nativeWidth <= 0) return 1.0;
  return Math.min(MAX_ZOOM, Math.max(0.25, availableWidth / nativeWidth));
}

export async function renderPdf(bytes) {
  pagesWrapper.innerHTML = "";
  try {
    pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (err) {
    pdfDoc = null;
    throw `Could not open PDF: ${err.message || err}`;
  }
  const fitZoom = await computeFitZoom();
  minZoom = fitZoom;
  zoomLevel = fitZoom;
  panX = 0;
  panY = 0;
  try {
    await rerenderAllPages({ animate: true });
  } catch (err) {
    pdfDoc = null;
    throw `Could not open PDF: ${err.message || err}`;
  }
}

async function rerenderAllPages({ animate = false } = {}) {
  const myGeneration = ++renderGeneration;
  if (!pdfDoc) {
    pagesWrapper.innerHTML = "";
    renderedContentWidth = 0;
    renderedContentHeight = 0;
    applyTransform();
    return;
  }

  const targetZoom = zoomLevel; // pin the scale for this pass even if a gesture keeps moving
  const outputScale = window.devicePixelRatio || 1;
  const fragment = document.createDocumentFragment();

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    if (myGeneration !== renderGeneration) return; // a newer render superseded this one
    const page = await pdfDoc.getPage(pageNum);
    if (myGeneration !== renderGeneration) return;
    const viewport = page.getViewport({ scale: targetZoom });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.className = animate ? "pdf-page pdf-page-enter" : "pdf-page";
    fragment.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
    await page.render({ canvasContext: ctx, viewport, transform }).promise;
    if (myGeneration !== renderGeneration) return;
  }

  if (myGeneration !== renderGeneration) return;
  pagesWrapper.innerHTML = "";
  pagesWrapper.appendChild(fragment);
  renderedZoom = targetZoom;
  // Measured post-layout, at scale 1 (renderedZoom === zoomLevel right now):
  // this is the exact on-screen content size, and the baseline contentSize()
  // scales from as zoomLevel moves away from renderedZoom afterward.
  renderedContentWidth = pagesWrapper.scrollWidth;
  renderedContentHeight = pagesWrapper.scrollHeight;
  updateView();
}
