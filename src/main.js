import { renderPdf } from "./viewer.js";

const { invoke } = window.__TAURI__.core;

const openBtn = document.getElementById("open-btn");
const status = document.getElementById("status");

async function handleOpenClick() {
  status.textContent = "";
  try {
    const bytes = await invoke("open_pdf_file");
    await renderPdf(new Uint8Array(bytes));
  } catch (err) {
    if (err === "cancelled") return;
    status.textContent = `Error: ${err}`;
  }
}

openBtn.addEventListener("click", handleOpenClick);
