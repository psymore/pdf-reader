import { computeZoom } from "./zoom.js";
import {
  DOCX_MAX_ZOOM,
  DOCX_MIN_ZOOM,
  clampDocxZoom,
  fitDocxZoom,
  scrollForZoom,
  stepDocxZoom,
} from "./docx-zoom.js";

const container = document.getElementById("docx-container");
const pagesEl = document.getElementById("docx-pages");

// Keep Word's page boundaries, headers/footers and notes. Images are
// embedded as data URLs so no blob: URLs leak across documents.
const RENDER_OPTIONS = {
  className: "docx",
  inWrapper: true,
  breakPages: true,
  ignoreLastRenderedPageBreak: true,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  useBase64URL: true,
};
const RESIZE_SETTLE_DELAY = 150;

let loaded = false;
let zoomLevel = 1;
let fitZoom = 1;
let naturalPageWidth = 0;
let renderGeneration = 0;
let resizeTimer = null;
let pinch = null;

function availableWidth() {
  const style = getComputedStyle(container);
  const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  return container.clientWidth - padding;
}

// Measured once per document at zoom 1, so later zoom changes don't skew it.
function measureWidestPage() {
  let widest = 0;
  for (const section of pagesEl.querySelectorAll("section.docx")) {
    widest = Math.max(widest, section.offsetWidth);
  }
  return widest;
}

function containerPoint(clientX, clientY) {
  const rect = container.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

// Applies a new zoom while keeping the content under (anchorX, anchorY) —
// container-relative px, default the center — where it was.
function setZoom(nextZoom, anchorX = container.clientWidth / 2, anchorY = container.clientHeight / 2) {
  const previous = zoomLevel;
  zoomLevel = clampDocxZoom(nextZoom);
  if (zoomLevel === previous) return;
  const left = scrollForZoom(container.scrollLeft, anchorX, previous, zoomLevel);
  const top = scrollForZoom(container.scrollTop, anchorY, previous, zoomLevel);
  pagesEl.style.zoom = String(zoomLevel);
  container.scrollLeft = left;
  container.scrollTop = top;
}

export async function renderDocx(bytes) {
  closeDocx();
  const generation = renderGeneration;
  const renderer = window.docx;
  if (!renderer?.renderAsync) {
    throw "Could not open Word document: the Word renderer failed to load";
  }
  // Render off-screen, then swap in: a render that a newer open superseded
  // must not overwrite what that newer open shows.
  const staging = document.createElement("div");
  try {
    await renderer.renderAsync(bytes, staging, staging, RENDER_OPTIONS);
  } catch (err) {
    throw `Could not open Word document: ${err?.message || err}`;
  }
  if (generation !== renderGeneration) return;

  pagesEl.style.zoom = "1";
  pagesEl.replaceChildren(...staging.childNodes);
  loaded = true;
  naturalPageWidth = measureWidestPage();
  fitZoom = fitDocxZoom(availableWidth(), naturalPageWidth);
  zoomLevel = fitZoom;
  pagesEl.style.zoom = String(zoomLevel);
  container.scrollTop = 0;
  container.scrollLeft = 0;
}

export function closeDocx() {
  renderGeneration += 1;
  clearTimeout(resizeTimer);
  loaded = false;
  pinch = null;
  zoomLevel = 1;
  fitZoom = 1;
  naturalPageWidth = 0;
  pagesEl.style.zoom = "1";
  pagesEl.replaceChildren();
}

export function zoomDocxByStep(direction) {
  if (!loaded) return;
  setZoom(stepDocxZoom(zoomLevel, direction));
}

export function resetDocxZoom() {
  if (!loaded) return;
  fitZoom = fitDocxZoom(availableWidth(), naturalPageWidth);
  setZoom(fitZoom);
  container.scrollLeft = 0;
}

container.addEventListener(
  "wheel",
  (event) => {
    // plain wheel/trackpad scrolling stays native
    if (!loaded || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const point = containerPoint(event.clientX, event.clientY);
    setZoom(
      computeZoom(zoomLevel, event.deltaY, { min: DOCX_MIN_ZOOM, max: DOCX_MAX_ZOOM }),
      point.x,
      point.y
    );
  },
  { passive: false }
);

// A link inside the document must never navigate the app's own webview
// away. Bookmark links ("#name") jump within the document; others are inert.
container.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute("href") ?? "";
  if (!href.startsWith("#") || href.length < 2) return;
  const target = document.getElementById(decodeURIComponent(href.slice(1)));
  if (target && pagesEl.contains(target)) target.scrollIntoView({ block: "start" });
});

window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!loaded) return;
    const wasFit = Math.abs(zoomLevel - fitZoom) < 0.001;
    fitZoom = fitDocxZoom(availableWidth(), naturalPageWidth);
    if (wasFit) setZoom(fitZoom);
  }, RESIZE_SETTLE_DELAY);
});
