import {
  renderPdf,
  closePdf,
  setStatusCallback,
  togglePageMode,
  setPageMode,
  isSinglePageMode,
  zoomByStep,
  resetZoom,
} from "./viewer.js";
import { renderDocx, closeDocx, zoomDocxByStep, resetDocxZoom } from "./docx-viewer.js";
import { detectDocumentKind, pickDroppedPath, LEGACY_DOC_MESSAGE } from "./document-kind.js";
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
const docxContainer = document.getElementById("docx-container");

// "pdf" | "docx" | null — which viewer currently shows a document.
let activeKind = null;
// Bumped on every open, so a slow render that finishes after a newer open
// started can tell it was superseded and leave the UI alone.
let openSequence = 0;

function setStatus(message) {
  status.textContent = message;
  status.classList.toggle("status-error", message.startsWith("Error"));
}

setStatusCallback(setStatus);

function showViewer(kind) {
  emptyState.hidden = true;
  viewerContainer.hidden = kind !== "pdf";
  docxContainer.hidden = kind !== "docx";
}

function showEmptyState() {
  emptyState.hidden = false;
  viewerContainer.hidden = true;
  docxContainer.hidden = true;
  activeKind = null;
  syncToolbarForKind(null);
  closeDocx();
  closePdf().catch(() => {
    // best-effort release; nothing is shown either way
  });
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

// Page layout (side-by-side) only applies to PDFs; zoom applies to both.
function syncToolbarForKind(kind) {
  pageModeBtn.hidden = kind !== "pdf";
  setLayoutControlsEnabled(kind === "pdf");
  zoomInBtn.hidden = kind === null;
  zoomOutBtn.hidden = kind === null;
  zoomResetBtn.hidden = kind === null;
  if (kind === "pdf") syncPageModeButton();
}

function closeToolbarMenu() {
  toolbarMenu.hidden = true;
  toolbarMenuBtn.setAttribute("aria-expanded", "false");
}

// Renders a file's bytes in the viewer that matches its contents (not its
// name — Android content:// URIs have none). Returns false when a newer open
// superseded this one mid-render; the caller must then leave the UI alone.
async function showDocument(bytes) {
  const sequence = ++openSequence;
  const data = new Uint8Array(bytes);
  // Unrecognized bytes go to PDF.js, which reports its own precise error.
  const kind = detectDocumentKind(data) ?? "pdf";
  if (kind === "doc") throw LEGACY_DOC_MESSAGE;
  activeKind = null;
  try {
    if (kind === "docx") {
      await closePdf();
      if (sequence !== openSequence) return false;
      showViewer("docx");
      await renderDocx(data);
    } else {
      closeDocx();
      showViewer("pdf");
      await renderPdf(data);
    }
  } catch (err) {
    if (sequence !== openSequence) return false;
    throw err;
  }
  if (sequence !== openSequence) return false;
  activeKind = kind;
  syncToolbarForKind(kind);
  return true;
}

async function openViaBytesResult(invokePromise) {
  setStatus("");
  loadingIndicator.hidden = false;
  try {
    const bytes = await invokePromise;
    if (await showDocument(bytes)) emit("file-opened", null);
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
    if (await showDocument(bytes)) emit("file-opened", { path });
  } catch (err) {
    setStatus(`Error: ${err}`);
    showEmptyState(); // don't strand the UI on a blank viewer pane
  } finally {
    loadingIndicator.hidden = true;
  }
}

function zoomActiveByStep(direction) {
  if (activeKind === "docx") zoomDocxByStep(direction);
  else zoomByStep(direction);
}

function resetActiveZoom() {
  if (activeKind === "docx") resetDocxZoom();
  else resetZoom();
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
zoomInBtn.addEventListener("click", () => zoomActiveByStep(1));
zoomOutBtn.addEventListener("click", () => zoomActiveByStep(-1));
zoomResetBtn.addEventListener("click", () => resetActiveZoom());

window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomActiveByStep(1);
  } else if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    zoomActiveByStep(-1);
  } else if (event.key === "0") {
    event.preventDefault();
    resetActiveZoom();
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
    const dropped = pickDroppedPath(event.payload.paths || []);
    if (dropped.error) {
      setStatus(dropped.error);
      return;
    }
    handleOpenRequested({ path: dropped.path });
  } else {
    document.body.classList.remove("drag-active");
  }
}).catch(() => {
  setStatus("Drag-and-drop unavailable.");
});
