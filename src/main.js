import {
  renderPdf,
  setStatusCallback,
  togglePageMode,
  setPageMode,
  isSinglePageMode,
  zoomByStep,
  resetZoom,
} from "./viewer.js";
import { emit, on } from "./app-events.js";
import { initSidebar } from "./sidebar.js";
import { initEmptyState } from "./empty-state.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWebview } = window.__TAURI__.webview;

const openBtn = document.getElementById("open-btn");
const pageModeBtn = document.getElementById("page-mode-btn");
const toolbarMenuWrap = document.getElementById("toolbar-menu-wrap");
const toolbarMenuBtn = document.getElementById("toolbar-menu-btn");
const toolbarMenu = document.getElementById("toolbar-menu");
const layoutMenuOptions = [...document.querySelectorAll("[data-page-layout]")];
const zoomInBtn = document.getElementById("zoom-in-btn");
const zoomOutBtn = document.getElementById("zoom-out-btn");
const zoomResetBtn = document.getElementById("zoom-reset-btn");
const status = document.getElementById("status");
const loadingIndicator = document.getElementById("loading-indicator");
const emptyState = document.getElementById("empty-state");
const viewerContainer = document.getElementById("viewer-container");

function setStatus(message) {
  status.textContent = message;
  status.classList.toggle("status-error", message.startsWith("Error"));
}

setStatusCallback(setStatus);

function showViewer() {
  emptyState.hidden = true;
  viewerContainer.hidden = false;
}

function showEmptyState() {
  emptyState.hidden = false;
  viewerContainer.hidden = true;
}

function syncPageModeButton() {
  const single = isSinglePageMode();
  pageModeBtn.classList.toggle("layout-active", !single);
  pageModeBtn.setAttribute("aria-pressed", String(!single));
  pageModeBtn.setAttribute("aria-label", single ? "Switch to side-by-side pages" : "Switch to vertical scrolling");
  pageModeBtn.title = single ? "Switch to side-by-side pages" : "Switch to vertical scrolling";
  for (const option of layoutMenuOptions) {
    const selected = option.dataset.pageLayout === (single ? "single" : "dual");
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-checked", String(selected));
  }
}

function setLayoutControlsEnabled(enabled) {
  for (const option of layoutMenuOptions) option.disabled = !enabled;
}

function closeToolbarMenu() {
  toolbarMenu.hidden = true;
  toolbarMenuBtn.setAttribute("aria-expanded", "false");
}

async function openViaBytesResult(invokePromise) {
  setStatus("");
  loadingIndicator.hidden = false;
  try {
    const bytes = await invokePromise;
    showViewer();
    await renderPdf(new Uint8Array(bytes));
    pageModeBtn.hidden = false;
    setLayoutControlsEnabled(true);
    zoomInBtn.hidden = false;
    zoomOutBtn.hidden = false;
    zoomResetBtn.hidden = false;
    syncPageModeButton();
    emit("file-opened", null);
  } catch (err) {
    if (err === "cancelled") return;
    setStatus(`Error: ${err}`);
    showEmptyState();
  } finally {
    loadingIndicator.hidden = true;
  }
}

async function handleOpenClick() {
  await openViaBytesResult(invoke("open_document_file"));
}

async function handleOpenRequested({ path }) {
  setStatus("");
  loadingIndicator.hidden = false;
  let bytes;
  try {
    bytes = await invoke("open_document_path", { path });
  } catch (err) {
    setStatus(`Error: ${err}`);
    loadingIndicator.hidden = true;
    try {
      await invoke("remove_recent_entry", { path });
    } catch {
      // best-effort cleanup; the read already failed, nothing more to do
    }
    emit("file-opened", null); // refresh sidebar to drop the dead entry
    return;
  }
  try {
    showViewer();
    await renderPdf(new Uint8Array(bytes));
    pageModeBtn.hidden = false;
    setLayoutControlsEnabled(true);
    zoomInBtn.hidden = false;
    zoomOutBtn.hidden = false;
    zoomResetBtn.hidden = false;
    syncPageModeButton();
    emit("file-opened", { path });
  } catch (err) {
    setStatus(`Error: ${err}`);
    showEmptyState(); // don't strand the UI on a blank viewer pane
  } finally {
    loadingIndicator.hidden = true;
  }
}

openBtn.addEventListener("click", handleOpenClick);
pageModeBtn.addEventListener("click", () => {
  togglePageMode();
  syncPageModeButton();
});
toolbarMenuBtn.addEventListener("click", () => {
  const opening = toolbarMenu.hidden;
  toolbarMenu.hidden = !opening;
  toolbarMenuBtn.setAttribute("aria-expanded", String(opening));
});
for (const option of layoutMenuOptions) {
  option.addEventListener("click", () => {
    setPageMode(option.dataset.pageLayout);
    syncPageModeButton();
    closeToolbarMenu();
  });
}
document.addEventListener("pointerdown", (event) => {
  if (!toolbarMenu.hidden && !toolbarMenuWrap.contains(event.target)) closeToolbarMenu();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeToolbarMenu();
});
zoomInBtn.addEventListener("click", () => zoomByStep(1));
zoomOutBtn.addEventListener("click", () => zoomByStep(-1));
zoomResetBtn.addEventListener("click", () => resetZoom());

window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomByStep(1);
  } else if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    zoomByStep(-1);
  } else if (event.key === "0") {
    event.preventDefault();
    resetZoom();
  }
});

let pageModeSyncTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(pageModeSyncTimer);
  pageModeSyncTimer = setTimeout(syncPageModeButton, 220);
});
on("dialog-open-requested", handleOpenClick);
on("open-requested", handleOpenRequested);

initSidebar();
initEmptyState();
showEmptyState();

invoke("get_launch_path").then((path) => {
  if (path) handleOpenRequested({ path });
});

getCurrentWebview().onDragDropEvent((event) => {
  const type = event.payload.type;
  if (type === "over") {
    document.body.classList.add("drag-active");
  } else if (type === "drop") {
    document.body.classList.remove("drag-active");
    const paths = event.payload.paths || [];
    const pdfPath = paths.find((p) => p.toLowerCase().endsWith(".pdf"));
    if (!pdfPath) {
      setStatus("Please drop a PDF file.");
      return;
    }
    handleOpenRequested({ path: pdfPath });
  } else {
    document.body.classList.remove("drag-active");
  }
}).catch(() => {
  setStatus("Drag-and-drop unavailable.");
});
