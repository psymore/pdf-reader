import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
import { computeZoom, stepZoom } from "./zoom.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";

const container = document.getElementById("viewer-container");
const pagesWrapper = document.getElementById("pdf-pages");

let pdfDoc = null;
let zoomLevel = 1.0;
let renderedZoom = 1.0; // zoom level the current canvases are actually sized at
let renderGeneration = 0;
let statusCallback = null;
let zoomChangeCallback = null;
let zoomDebounceTimer = null;
let doubleTapBaseZoom = null; // set while a double-tap/double-click has zoomed in; null once back at base

export function setStatusCallback(fn) {
  statusCallback = fn;
}

export function setZoomChangeCallback(fn) {
  zoomChangeCallback = fn;
}

function reportError(message) {
  if (statusCallback) {
    statusCallback(message);
  }
}

function setZoom(newZoom) {
  zoomLevel = newZoom;
  if (zoomChangeCallback) zoomChangeCallback(zoomLevel);
}

export function getZoom() {
  return zoomLevel;
}

container.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey) return; // plain scroll: let native pan happen
    event.preventDefault();
    doubleTapBaseZoom = null;
    setZoom(computeZoom(zoomLevel, event.deltaY));
    clearTimeout(zoomDebounceTimer);
    zoomDebounceTimer = setTimeout(() => {
      rerenderAllPages().catch((err) => {
        reportError(`Could not render PDF: ${err.message || err}`);
      });
    }, 120);
  },
  { passive: false }
);

// Pinch-to-zoom: the viewport disables the browser's own pinch-zoom (it would
// fight the app's zoom state), so this reimplements it directly. Mirrors the
// ctrl+wheel handler above — update the displayed zoom live as fingers move,
// but only pay for an actual canvas re-render once the gesture settles.
let pinchStartDistance = null;
let pinchStartZoom = null;

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

container.addEventListener(
  "touchstart",
  (event) => {
    if (event.touches.length === 2 && pdfDoc) {
      doubleTapBaseZoom = null;
      pinchStartDistance = touchDistance(event.touches);
      pinchStartZoom = zoomLevel;
    }
  },
  { passive: true }
);

container.addEventListener(
  "touchmove",
  (event) => {
    if (event.touches.length !== 2 || pinchStartDistance === null) return;
    const scale = touchDistance(event.touches) / pinchStartDistance;
    setZoom(Math.min(4.0, Math.max(0.25, pinchStartZoom * scale)));
    clearTimeout(zoomDebounceTimer);
    zoomDebounceTimer = setTimeout(() => {
      rerenderAllPages().catch((err) => {
        reportError(`Could not render PDF: ${err.message || err}`);
      });
    }, 120);
  },
  { passive: true }
);

const endPinch = () => {
  pinchStartDistance = null;
  pinchStartZoom = null;
};

container.addEventListener("touchend", (event) => {
  if (event.touches.length < 2) endPinch();
});
container.addEventListener("touchcancel", endPinch);

// Desktop double-click and a mobile double-tap both fire "dblclick"; toggle
// between the current zoom and 2x it, so phones get a zoom gesture without
// needing full pinch-to-zoom support.
container.addEventListener("dblclick", (event) => {
  if (!pdfDoc) return;
  event.preventDefault();
  if (doubleTapBaseZoom === null) {
    doubleTapBaseZoom = zoomLevel;
    setZoom(Math.min(4.0, zoomLevel * 2));
  } else {
    setZoom(doubleTapBaseZoom);
    doubleTapBaseZoom = null;
  }
  rerenderAllPages().catch((err) => {
    reportError(`Could not render PDF: ${err.message || err}`);
  });
});

export async function zoomIn() {
  doubleTapBaseZoom = null;
  setZoom(stepZoom(zoomLevel, 1));
  await rerenderAllPages();
}

export async function zoomOut() {
  doubleTapBaseZoom = null;
  setZoom(stepZoom(zoomLevel, -1));
  await rerenderAllPages();
}

// Resets to the fit-width zoom (not a hard 100%) since that's the view that
// actually fits the screen regardless of the page's native size, and snaps
// scroll back to the top-left corner so a pan/zoom excursion is fully undone.
export async function resetZoom() {
  doubleTapBaseZoom = null;
  setZoom(await computeFitZoom());
  await rerenderAllPages();
  container.scrollTop = 0;
  container.scrollLeft = 0;
}

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
  return Math.min(4.0, Math.max(0.25, availableWidth / nativeWidth));
}

export async function renderPdf(bytes) {
  doubleTapBaseZoom = null;
  pagesWrapper.innerHTML = "";
  try {
    pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (err) {
    pdfDoc = null;
    throw `Could not open PDF: ${err.message || err}`;
  }
  const fitZoom = await computeFitZoom();
  setZoom(fitZoom);
  renderedZoom = fitZoom;
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
    renderedZoom = zoomLevel;
    return;
  }

  const targetZoom = zoomLevel; // pin the scale for this pass even if the wheel keeps moving
  // The old canvases are about to be replaced by ones a different physical
  // size; scale the scroll offset by the same ratio the content is about
  // to change by, so whatever was in view stays in view instead of the
  // browser clamping scrollTop (zooming out) or the same pixel offset
  // silently pointing at different content (zooming in).
  const scrollRatio = renderedZoom > 0 ? targetZoom / renderedZoom : 1;
  const previousScrollTop = container.scrollTop;
  const previousScrollLeft = container.scrollLeft;

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
  container.scrollTop = previousScrollTop * scrollRatio;
  container.scrollLeft = previousScrollLeft * scrollRatio;
}
