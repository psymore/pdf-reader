import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";

const container = document.getElementById("viewer-container");

let pdfDoc = null;
let zoomLevel = 1.0;

export async function renderPdf(bytes) {
  pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
  zoomLevel = 1.0;
  await rerenderAllPages();
}

async function rerenderAllPages() {
  container.innerHTML = "";
  if (!pdfDoc) return;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: zoomLevel });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.className = "pdf-page";
    container.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
  }
}

export function getZoomLevel() {
  return zoomLevel;
}

export async function setZoomLevel(newZoom) {
  zoomLevel = newZoom;
  await rerenderAllPages();
}
