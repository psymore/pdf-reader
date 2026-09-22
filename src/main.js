import { renderPdf, setStatusCallback, setZoomChangeCallback, zoomIn, zoomOut, resetZoom } from "./viewer.js";
import { emit, on } from "./app-events.js";
import { initSidebar } from "./sidebar.js";
import { initEmptyState } from "./empty-state.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWebview } = window.__TAURI__.webview;

const openBtn = document.getElementById("open-btn");
const status = document.getElementById("status");
const emptyState = document.getElementById("empty-state");
const viewerContainer = document.getElementById("viewer-container");
const zoomPill = document.getElementById("zoom-pill");
const zoomOutBtn = document.getElementById("zoom-out");
const zoomInBtn = document.getElementById("zoom-in");
const zoomLevelBtn = document.getElementById("zoom-level");

function setStatus(message) {
  status.textContent = message;
  status.classList.toggle("status-error", message.startsWith("Error"));
}

setStatusCallback(setStatus);

setZoomChangeCallback((zoom) => {
  zoomLevelBtn.textContent = `${Math.round(zoom * 100)}%`;
});

function showViewer() {
  emptyState.hidden = true;
  viewerContainer.hidden = false;
  zoomPill.hidden = false;
}

function showEmptyState() {
  emptyState.hidden = false;
  viewerContainer.hidden = true;
  zoomPill.hidden = true;
}

async function openViaBytesResult(invokePromise) {
  setStatus("");
  try {
    const bytes = await invokePromise;
    await renderPdf(new Uint8Array(bytes));
    showViewer();
    emit("file-opened", null);
  } catch (err) {
    if (err === "cancelled") return;
    setStatus(`Error: ${err}`);
  }
}

async function handleOpenClick() {
  await openViaBytesResult(invoke("open_pdf_file"));
}

async function handleOpenRequested({ path }) {
  setStatus("");
  let bytes;
  try {
    bytes = await invoke("open_pdf_path", { path });
  } catch (err) {
    setStatus(`Error: ${err}`);
    try {
      await invoke("remove_recent_entry", { path });
    } catch {
      // best-effort cleanup; the read already failed, nothing more to do
    }
    emit("file-opened", null); // refresh sidebar to drop the dead entry
    return;
  }
  try {
    await renderPdf(new Uint8Array(bytes));
    showViewer();
    emit("file-opened", { path });
  } catch (err) {
    setStatus(`Error: ${err}`);
    showEmptyState(); // don't strand the UI on a blank viewer pane
  }
}

openBtn.addEventListener("click", handleOpenClick);
on("dialog-open-requested", handleOpenClick);
on("open-requested", handleOpenRequested);

zoomOutBtn.addEventListener("click", () => {
  zoomOut().catch((err) => setStatus(`Error: ${err.message || err}`));
});
zoomInBtn.addEventListener("click", () => {
  zoomIn().catch((err) => setStatus(`Error: ${err.message || err}`));
});
zoomLevelBtn.addEventListener("click", () => {
  resetZoom().catch((err) => setStatus(`Error: ${err.message || err}`));
});

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
