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

export async function zoomIn() {
  setZoom(stepZoom(zoomLevel, 1));
  await rerenderAllPages();
}

export async function zoomOut() {
  setZoom(stepZoom(zoomLevel, -1));
  await rerenderAllPages();
}

export async function resetZoom() {
  setZoom(1.0);
  await rerenderAllPages();
}

export async function renderPdf(bytes) {
  try {
    pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (err) {
    pdfDoc = null;
    pagesWrapper.innerHTML = "";
    throw `Could not open PDF: ${err.message || err}`;
  }
  setZoom(1.0);
  renderedZoom = 1.0;
  try {
    await rerenderAllPages({ animate: true });
  } catch (err) {
    pdfDoc = null;
    pagesWrapper.innerHTML = "";
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
