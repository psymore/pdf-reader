import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
import { computeZoom } from "./zoom.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";

const container = document.getElementById("viewer-container");

let pdfDoc = null;
let zoomLevel = 1.0;
let renderGeneration = 0;
let statusCallback = null;
let zoomDebounceTimer = null;

export function setStatusCallback(fn) {
  statusCallback = fn;
}

function reportError(message) {
  if (statusCallback) {
    statusCallback(message);
  }
}

container.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey) return; // plain scroll: let native pan happen
    event.preventDefault();
    zoomLevel = computeZoom(zoomLevel, event.deltaY);
    clearTimeout(zoomDebounceTimer);
    zoomDebounceTimer = setTimeout(() => {
      rerenderAllPages().catch((err) => {
        reportError(`Could not render PDF: ${err.message || err}`);
      });
    }, 120);
  },
  { passive: false }
);

export async function renderPdf(bytes) {
  try {
    pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  } catch (err) {
    pdfDoc = null;
    container.innerHTML = "";
    throw `Could not open PDF: ${err.message || err}`;
  }
  zoomLevel = 1.0;
  try {
    await rerenderAllPages();
  } catch (err) {
    pdfDoc = null;
    container.innerHTML = "";
    throw `Could not open PDF: ${err.message || err}`;
  }
}

async function rerenderAllPages() {
  const myGeneration = ++renderGeneration;
  if (!pdfDoc) {
    container.innerHTML = "";
    return;
  }

  const outputScale = window.devicePixelRatio || 1;
  const fragment = document.createDocumentFragment();

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    if (myGeneration !== renderGeneration) return; // a newer render superseded this one
    const page = await pdfDoc.getPage(pageNum);
    if (myGeneration !== renderGeneration) return;
    const viewport = page.getViewport({ scale: zoomLevel });

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.className = "pdf-page";
    fragment.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
    await page.render({ canvasContext: ctx, viewport, transform }).promise;
    if (myGeneration !== renderGeneration) return;
  }

  if (myGeneration !== renderGeneration) return;
  container.innerHTML = "";
  container.appendChild(fragment);
}
