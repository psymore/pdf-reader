import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
import { computeZoom } from "./zoom.js";
import {
  computeFitZoom as fitZoomForPages,
  computePageColumns,
  resolveDualPageMode,
} from "./page-layout.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";

const container = document.getElementById("viewer-container");
const pagesWrapper = document.getElementById("pdf-pages");

const MAX_ZOOM = 4.0;
const MIN_SINGLE_PAGE_ZOOM = 0.25;
const MIN_DUAL_PAGE_ZOOM = 0.1;
const DESKTOP_PAGE_GAP = 16;
const MOBILE_PAGE_GAP = 12;
const RESIZE_SETTLE_DELAY = 150;
const ZOOM_RERENDER_DELAY = 120;
const PAGE_METADATA_BATCH_SIZE = 16;

let pdfDoc = null;
let pdfLoadingTask = null;
// Bumped by every closePdf(); a renderPdf that sees it change was superseded.
let loadToken = 0;
let pages = [];
let pageModePreference = null;
let zoomLevel = 1;
let panX = 0;
let panY = 0;
let renderedZoom = 1;
let renderedContentWidth = 0;
let renderedContentHeight = 0;
let renderGeneration = 0;
let statusCallback = null;
let zoomDebounceTimer = null;
let resizeDebounceTimer = null;
let pageObserver = null;
let pendingZoomAnchor = null;
let fitZoom = 1;
let gesture = null;

function isDualPageMode() {
  return resolveDualPageMode(window.innerWidth, pdfDoc?.numPages ?? 0, pageModePreference);
}

function minimumZoom() {
  return isDualPageMode() ? MIN_DUAL_PAGE_ZOOM : MIN_SINGLE_PAGE_ZOOM;
}

function getPageGap() {
  return window.matchMedia("(max-width: 640px)").matches ? MOBILE_PAGE_GAP : DESKTOP_PAGE_GAP;
}

function reportError(message) {
  if (statusCallback) statusCallback(message);
}

function cancelPageRender(page) {
  page.renderToken += 1;
  page.rendering = false;
  if (page.renderTask) {
    page.renderTask.cancel();
    page.renderTask = null;
  }
}

function cancelAllPageRenders() {
  for (const page of pages) {
    cancelPageRender(page);
    if (page.canvas) {
      page.canvas.width = 0;
      page.canvas.height = 0;
      page.canvas = null;
    }
    page.slot = null;
  }
}

function contentSize() {
  const scale = renderedZoom > 0 ? zoomLevel / renderedZoom : 1;
  return {
    width: renderedContentWidth * scale,
    height: renderedContentHeight * scale,
  };
}

function clampPan() {
  const { width, height } = contentSize();
  const viewportWidth = container.clientWidth;
  const viewportHeight = container.clientHeight;
  const containerStyle = getComputedStyle(container);
  const topInset = Number.parseFloat(containerStyle.paddingTop) || 0;
  const bottomInset = Number.parseFloat(containerStyle.paddingBottom) || 0;
  const usableHeight = Math.max(0, viewportHeight - topInset - bottomInset);
  panX = width <= viewportWidth
    ? (viewportWidth - width) / 2
    : Math.min(0, Math.max(viewportWidth - width, panX));
  panY = height <= usableHeight
    ? (usableHeight - height) / 2
    : Math.min(0, Math.max(usableHeight - height, panY));
}

function applyTransform() {
  const scale = renderedZoom > 0 ? zoomLevel / renderedZoom : 1;
  pagesWrapper.style.transformOrigin = "0 0";
  pagesWrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
}

function updateView({ rerender = false, anchor = null } = {}) {
  clampPan();
  applyTransform();
  if (rerender) {
    if (anchor) pendingZoomAnchor = anchor;
    scheduleRerender();
  }
}

function scheduleRerender(delay = ZOOM_RERENDER_DELAY) {
  clearTimeout(zoomDebounceTimer);
  zoomDebounceTimer = setTimeout(() => {
    rerenderPages({ anchor: pendingZoomAnchor }).catch((err) => {
      reportError(`Could not render PDF: ${err.message || err}`);
    });
  }, delay);
}

function containerRelativePoint(clientX, clientY) {
  const rect = container.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function captureAnchor(point) {
  const containerRect = container.getBoundingClientRect();
  const clientPoint = {
    x: point.x + containerRect.left,
    y: point.y + containerRect.top,
  };
  const contentPoint = {
    x: (point.x - panX) / zoomLevel,
    y: (point.y - pagesWrapper.offsetTop - panY) / zoomLevel,
  };
  let nearestPage = null;
  let nearestDistance = Infinity;

  for (const page of pages) {
    if (!page.slot) continue;
    const rect = page.slot.getBoundingClientRect();
    if (clientPoint.x >= rect.left && clientPoint.x <= rect.right &&
      clientPoint.y >= rect.top && clientPoint.y <= rect.bottom) {
      return {
        pageNumber: page.pageNumber,
        xRatio: rect.width ? (clientPoint.x - rect.left) / rect.width : 0.5,
        yRatio: rect.height ? (clientPoint.y - rect.top) / rect.height : 0.5,
        point,
        contentPoint,
      };
    }

    const dx = clientPoint.x - (rect.left + rect.width / 2);
    const dy = clientPoint.y - (rect.top + rect.height / 2);
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestPage = {
        pageNumber: page.pageNumber,
        xRatio: 0.5,
        yRatio: 0.5,
        point,
        contentPoint,
      };
    }
  }
  return nearestPage || { pageNumber: null, point, contentPoint };
}

function restoreAnchor(anchor, targetZoom) {
  if (anchor?.pageNumber) {
    const page = pages[anchor.pageNumber - 1];
    if (page?.slot) {
      const scale = zoomLevel / targetZoom;
      const originTop = pagesWrapper.offsetTop;
      const contentX = page.slot.offsetLeft + page.slot.offsetWidth * anchor.xRatio;
      const contentY = originTop + page.slot.offsetTop + page.slot.offsetHeight * anchor.yRatio;
      panX = anchor.point.x - contentX * scale;
      panY = anchor.point.y - contentY * scale;
      return;
    }
  }
  if (anchor?.point) {
    panX = anchor.point.x - anchor.contentPoint.x * zoomLevel;
    panY = anchor.point.y - pagesWrapper.offsetTop - anchor.contentPoint.y * zoomLevel;
  }
}

function zoomAt(anchor, newZoom) {
  const capturedAnchor = captureAnchor(anchor);
  const clampedZoom = Math.min(MAX_ZOOM, Math.max(minimumZoom(), newZoom));
  const contentX = (anchor.x - panX) / zoomLevel;
  const contentY = (anchor.y - pagesWrapper.offsetTop - panY) / zoomLevel;
  zoomLevel = clampedZoom;
  panX = anchor.x - contentX * zoomLevel;
  panY = anchor.y - pagesWrapper.offsetTop - contentY * zoomLevel;
  updateView({ rerender: true, anchor: capturedAnchor });
}

export function togglePageMode() {
  return setPageMode(isDualPageMode() ? "single" : "dual");
}

export function setPageMode(mode) {
  if (mode !== "single" && mode !== "dual") return isSinglePageMode();
  const anchor = pdfDoc ? captureAnchor({
    x: container.clientWidth / 2,
    y: container.clientHeight / 2,
  }) : null;
  const nextIsDual = mode === "dual";
  pageModePreference = nextIsDual ? "dual" : "single";
  if (pdfDoc) {
    computeFitZoom().then((nextFitZoom) => {
      zoomLevel = Math.max(minimumZoom(), zoomLevel);
      if (nextIsDual && zoomLevel > nextFitZoom) zoomLevel = nextFitZoom;
      fitZoom = nextFitZoom;
      rerenderPages({ anchor }).catch((err) => {
        reportError(`Could not render PDF: ${err.message || err}`);
      });
    }).catch((err) => {
      reportError(`Could not calculate page layout: ${err.message || err}`);
    });
  }
  return !nextIsDual;
}

export function isSinglePageMode() {
  return !isDualPageMode();
}

export function zoomByStep(direction) {
  if (!pdfDoc) return;
  const step = 0.2;
  const factor = direction > 0 ? 1 + step : 1 / (1 + step);
  zoomAt(
    { x: container.clientWidth / 2, y: container.clientHeight / 2 },
    zoomLevel * factor
  );
}

export async function resetZoom() {
  if (!pdfDoc) return;
  const anchor = captureAnchor({
    x: container.clientWidth / 2,
    y: container.clientHeight / 2,
  });
  fitZoom = await computeFitZoom();
  zoomLevel = fitZoom;
  panX = 0;
  panY = 0;
  pendingZoomAnchor = anchor;
  updateView({ rerender: true });
}

export function setStatusCallback(fn) {
  statusCallback = fn;
}

function computeColumns(targetZoom) {
  const widestPage = Math.max(...pages.map((page) => page.width));
  const columns = computePageColumns(
    container.clientWidth,
    widestPage * targetZoom,
    getPageGap(),
    isDualPageMode(),
    pages.length
  );
  return columns;
}

async function computeFitZoom() {
  if (!pdfDoc || pages.length === 0) return 1;
  const widestPage = Math.max(...pages.map((page) => page.width));
  const zoom = fitZoomForPages(
    container.clientWidth,
    widestPage,
    getPageGap(),
    isDualPageMode()
  );
  return Math.min(MAX_ZOOM, Math.max(minimumZoom(), zoom));
}

async function loadPageMetadata() {
  const metadata = [];
  for (let start = 1; start <= pdfDoc.numPages; start += PAGE_METADATA_BATCH_SIZE) {
    const end = Math.min(pdfDoc.numPages, start + PAGE_METADATA_BATCH_SIZE - 1);
    const batch = await Promise.all(
      Array.from({ length: end - start + 1 }, async (_, index) => {
        const pageNumber = start + index;
        const page = await pdfDoc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        return {
          pageNumber,
          width: viewport.width,
          height: viewport.height,
          slot: null,
          canvas: null,
          renderTask: null,
          renderToken: 0,
          rendering: false,
        };
      })
    );
    metadata.push(...batch);
  }
  return metadata;
}

function makePageSlot(page, targetZoom, animate) {
  const slot = document.createElement("div");
  slot.className = animate ? "pdf-page-slot pdf-page-enter" : "pdf-page-slot";
  slot.dataset.pageNumber = String(page.pageNumber);
  slot.style.width = `${page.width * targetZoom}px`;
  slot.style.height = `${page.height * targetZoom}px`;
  page.slot = slot;
  page.canvas = null;
  return slot;
}

function createObserver(generation) {
  pageObserver?.disconnect();
  if (!("IntersectionObserver" in window)) {
    renderNearViewport(generation).catch((err) => {
      reportError(`Could not render PDF: ${err.message || err}`);
    });
    return;
  }

  pageObserver = new IntersectionObserver(
    (entries) => {
      if (generation !== renderGeneration) return;
      for (const entry of entries) {
        const pageNumber = Number(entry.target.dataset.pageNumber);
        const page = pages[pageNumber - 1];
        if (!page) continue;
        if (entry.isIntersecting) {
          renderPage(page, generation).catch((err) => {
            reportError(`Could not render page ${pageNumber}: ${err.message || err}`);
          });
        } else {
          unloadPage(page);
        }
      }
    },
    {
      root: container,
      rootMargin: `${Math.max(container.clientHeight, 1)}px 0px`,
      threshold: 0,
    }
  );

  for (const page of pages) pageObserver.observe(page.slot);
}

function unloadPage(page) {
  cancelPageRender(page);
  if (!page.canvas || !page.slot) return;
  page.canvas.width = 0;
  page.canvas.height = 0;
  page.slot.replaceChildren();
  page.canvas = null;
}

async function renderPage(page, generation) {
  if (generation !== renderGeneration || !page.slot || page.canvas || page.rendering) return;
  page.rendering = true;
  const token = ++page.renderToken;
  try {
    const pageProxy = await pdfDoc.getPage(page.pageNumber);
    if (generation !== renderGeneration || token !== page.renderToken) return;

    const viewport = pageProxy.getViewport({ scale: renderedZoom });
    const outputScale = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.className = "pdf-page";
    page.canvas = canvas;
    page.slot.replaceChildren(canvas);

    const context = canvas.getContext("2d");
    if (!context) {
      page.canvas = null;
      page.slot.replaceChildren();
      throw new Error(`Could not create a canvas context for page ${page.pageNumber}`);
    }

    const task = pageProxy.render({
      canvasContext: context,
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    });
    page.renderTask = task;
    try {
      await task.promise;
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") {
        canvas.width = 0;
        canvas.height = 0;
        if (page.canvas === canvas) {
          page.canvas = null;
          page.slot.replaceChildren();
        }
        throw err;
      }
    } finally {
      if (page.renderTask === task) page.renderTask = null;
      if (generation !== renderGeneration || token !== page.renderToken) {
        if (page.canvas === canvas) {
          canvas.width = 0;
          canvas.height = 0;
          page.canvas = null;
          page.slot?.replaceChildren();
        }
      }
    }
  } finally {
    if (token === page.renderToken) page.rendering = false;
  }
}

async function renderNearViewport(generation) {
  const viewport = container.getBoundingClientRect();
  const margin = Math.max(viewport.height, 1);
  const nearby = pages.filter((page) => {
    const rect = page.slot.getBoundingClientRect();
    return rect.bottom >= viewport.top - margin && rect.top <= viewport.bottom + margin;
  });
  await Promise.all(nearby.map((page) => renderPage(page, generation)));
}

async function rerenderPages({ animate = false, anchor = null } = {}) {
  if (!pdfDoc) {
    pageObserver?.disconnect();
    cancelAllPageRenders();
    pagesWrapper.replaceChildren();
    renderedContentWidth = 0;
    renderedContentHeight = 0;
    applyTransform();
    return;
  }

  const generation = ++renderGeneration;
  pageObserver?.disconnect();
  cancelAllPageRenders();
  const targetZoom = zoomLevel;
  const columns = computeColumns(targetZoom);
  const fragment = document.createDocumentFragment();

  pagesWrapper.style.setProperty("--page-columns", String(columns));
  pagesWrapper.style.setProperty("--page-gap", `${getPageGap()}px`);
  pagesWrapper.classList.toggle("single-page-mode", !isDualPageMode());
  pagesWrapper.classList.toggle("dual-page-mode", isDualPageMode());

  for (const page of pages) fragment.appendChild(makePageSlot(page, targetZoom, animate));
  pagesWrapper.replaceChildren(fragment);

  renderedZoom = targetZoom;
  renderedContentWidth = pagesWrapper.scrollWidth;
  renderedContentHeight = pagesWrapper.scrollHeight;
  if (anchor) restoreAnchor(anchor, targetZoom);
  clampPan();
  applyTransform();
  createObserver(generation);

  await renderNearViewport(generation);
  if (generation !== renderGeneration) return;
  pendingZoomAnchor = null;
}

// Releases the open PDF (page renders, observer, pending timers, the PDF.js
// document) and clears the page area. Safe to call when nothing is open.
export async function closePdf() {
  loadToken += 1;
  clearTimeout(zoomDebounceTimer);
  clearTimeout(resizeDebounceTimer);
  pageObserver?.disconnect();
  pageObserver = null;
  cancelAllPageRenders();
  pagesWrapper.replaceChildren();
  const previousLoadingTask = pdfLoadingTask;
  pdfLoadingTask = null;
  pdfDoc = null;
  pages = [];
  gesture = null;
  pendingZoomAnchor = null;
  renderedContentWidth = 0;
  renderedContentHeight = 0;
  renderGeneration += 1;
  if (previousLoadingTask) {
    await previousLoadingTask.destroy();
  }
}

// Drops a load that a later closePdf() superseded. Only the task this load
// created is released, and only if nobody else took it over already.
async function releaseSupersededLoad(loadingTask) {
  if (!loadingTask || pdfLoadingTask !== loadingTask) return;
  pdfLoadingTask = null;
  pdfDoc = null;
  try {
    await loadingTask.destroy();
  } catch (destroyError) {
    reportError(`Could not release the superseded PDF load: ${destroyError.message || destroyError}`);
  }
}

export async function renderPdf(bytes) {
  // closePdf() bumps loadToken before its first await, so the token is read
  // right after that bump: any later closePdf() (a newer open, PDF or Word)
  // marks this load as superseded, even while this one is still closing.
  const closing = closePdf();
  const token = loadToken;
  await closing;
  if (token !== loadToken) return;
  pageModePreference = null;
  let loadingTask = null;
  try {
    loadingTask = pdfjsLib.getDocument({ data: bytes });
    pdfLoadingTask = loadingTask;
    const loadedDoc = await loadingTask.promise;
    if (token !== loadToken) {
      await releaseSupersededLoad(loadingTask);
      return;
    }
    pdfDoc = loadedDoc;
  } catch (err) {
    if (token !== loadToken) {
      await releaseSupersededLoad(loadingTask);
      return;
    }
    const failedLoadingTask = pdfLoadingTask;
    pdfLoadingTask = null;
    pdfDoc = null;
    if (failedLoadingTask) {
      try {
        await failedLoadingTask.destroy();
      } catch (destroyError) {
        reportError(`Could not release the failed PDF load: ${destroyError.message || destroyError}`);
      }
    }
    throw `Could not open PDF: ${err.message || err}`;
  }

  try {
    const loadedPages = await loadPageMetadata();
    if (token !== loadToken) {
      await releaseSupersededLoad(loadingTask);
      return;
    }
    pages = loadedPages;
    fitZoom = await computeFitZoom();
    zoomLevel = fitZoom;
    panX = 0;
    panY = 0;
    await rerenderPages({ animate: true });
  } catch (err) {
    if (token !== loadToken) {
      // closePdf() already cleared this load; the state now belongs to the
      // newer open, so leave it alone.
      await releaseSupersededLoad(loadingTask);
      return;
    }
    pageObserver?.disconnect();
    cancelAllPageRenders();
    renderGeneration += 1;
    const failedLoadingTask = pdfLoadingTask;
    pdfLoadingTask = null;
    pdfDoc = null;
    pages = [];
    pagesWrapper.replaceChildren();
    if (failedLoadingTask) {
      try {
        await failedLoadingTask.destroy();
      } catch (destroyError) {
        reportError(`Could not release the failed PDF: ${destroyError.message || destroyError}`);
      }
    }
    throw `Could not open PDF: ${err.message || err}`;
  }
}

function zoomByWheel(event) {
  const anchor = containerRelativePoint(event.clientX, event.clientY);
  zoomAt(anchor, computeZoom(zoomLevel, event.deltaY, { min: minimumZoom(), max: MAX_ZOOM }));
}

container.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (!pdfDoc) return;
    if (event.ctrlKey || event.metaKey) {
      zoomByWheel(event);
    } else {
      panX -= event.deltaX;
      panY -= event.deltaY;
      updateView();
    }
  },
  { passive: false }
);

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
    const first = touchPoint(touches[0]);
    const second = touchPoint(touches[1]);
    gesture = {
      kind: "pinch",
      startMid: midpoint(first, second),
      startDistance: distance(first, second),
      startZoom: zoomLevel,
      startPanX: panX,
      startPanY: panY,
    };
  } else {
    gesture = null;
  }
}

container.addEventListener("touchstart", (event) => {
  if (!pdfDoc) return;
  beginGesture(event.touches);
}, { passive: true });

container.addEventListener("touchmove", (event) => {
  if (!gesture || !pdfDoc) return;
  event.preventDefault();

  if (gesture.kind === "pan" && event.touches.length === 1) {
    const point = touchPoint(event.touches[0]);
    panX = gesture.startPanX + point.x - gesture.start.x;
    panY = gesture.startPanY + point.y - gesture.start.y;
    updateView();
  } else if (gesture.kind === "pinch" && event.touches.length === 2) {
    const first = touchPoint(event.touches[0]);
    const second = touchPoint(event.touches[1]);
    const mid = midpoint(first, second);
    pendingZoomAnchor = captureAnchor(mid);
    const scale = distance(first, second) / gesture.startDistance;
    const newZoom = Math.min(MAX_ZOOM, Math.max(minimumZoom(), gesture.startZoom * scale));
    const contentX = (gesture.startMid.x - gesture.startPanX) / gesture.startZoom;
    const contentY = (gesture.startMid.y - pagesWrapper.offsetTop - gesture.startPanY) / gesture.startZoom;
    zoomLevel = newZoom;
    panX = mid.x - contentX * zoomLevel;
    panY = mid.y - pagesWrapper.offsetTop - contentY * zoomLevel;
    updateView();
  } else {
    beginGesture(event.touches);
  }
}, { passive: false });

function commitZoom() {
  clearTimeout(zoomDebounceTimer);
  rerenderPages({ anchor: pendingZoomAnchor }).catch((err) => {
    reportError(`Could not render PDF: ${err.message || err}`);
  });
}

container.addEventListener("touchend", (event) => {
  const wasZooming = gesture?.kind === "pinch";
  if (event.touches.length === 0) {
    gesture = null;
  } else {
    beginGesture(event.touches);
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
  resizeDebounceTimer = setTimeout(async () => {
    if (!pdfDoc) return;
    const anchor = captureAnchor({
      x: container.clientWidth / 2,
      y: container.clientHeight / 2,
    });
    try {
      const nextFitZoom = await computeFitZoom();
      if (Math.abs(zoomLevel - fitZoom) < 0.001) zoomLevel = nextFitZoom;
      fitZoom = nextFitZoom;
      await rerenderPages({ anchor });
    } catch (err) {
      reportError(`Could not update PDF layout: ${err.message || err}`);
    }
  }, RESIZE_SETTLE_DELAY);
});
