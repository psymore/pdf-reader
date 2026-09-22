import { renderPdf, setStatusCallback } from "./viewer.js";
import { emit, on } from "./app-events.js";
import { initSidebar } from "./sidebar.js";
import { initEmptyState } from "./empty-state.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWebview } = window.__TAURI__.webview;

const openBtn = document.getElementById("open-btn");
const status = document.getElementById("status");
const emptyState = document.getElementById("empty-state");
const viewerContainer = document.getElementById("viewer-container");

setStatusCallback((message) => {
  status.textContent = message;
});

function showViewer() {
  emptyState.hidden = true;
  viewerContainer.hidden = false;
}

function showEmptyState() {
  emptyState.hidden = false;
  viewerContainer.hidden = true;
}

async function openViaBytesResult(invokePromise) {
  status.textContent = "";
  try {
    const bytes = await invokePromise;
    await renderPdf(new Uint8Array(bytes));
    showViewer();
    emit("file-opened", null);
  } catch (err) {
    if (err === "cancelled") return;
    status.textContent = `Error: ${err}`;
  }
}

async function handleOpenClick() {
  await openViaBytesResult(invoke("open_pdf_file"));
}

async function handleOpenRequested({ path }) {
  status.textContent = "";
  let bytes;
  try {
    bytes = await invoke("open_pdf_path", { path });
  } catch (err) {
    status.textContent = `Error: ${err}`;
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
    status.textContent = `Error: ${err}`;
    showEmptyState(); // don't strand the UI on a blank viewer pane
  }
}

openBtn.addEventListener("click", handleOpenClick);
on("dialog-open-requested", handleOpenClick);
on("open-requested", handleOpenRequested);

initSidebar();
initEmptyState();
showEmptyState();

getCurrentWebview().onDragDropEvent((event) => {
  const type = event.payload.type;
  if (type === "over") {
    document.body.classList.add("drag-active");
  } else if (type === "drop") {
    document.body.classList.remove("drag-active");
    const paths = event.payload.paths || [];
    const pdfPath = paths.find((p) => p.toLowerCase().endsWith(".pdf"));
    if (!pdfPath) {
      status.textContent = "Please drop a PDF file.";
      return;
    }
    handleOpenRequested({ path: pdfPath });
  } else {
    document.body.classList.remove("drag-active");
  }
}).catch(() => {
  status.textContent = "Drag-and-drop unavailable.";
});
