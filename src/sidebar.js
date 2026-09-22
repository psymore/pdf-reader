import { groupByPinned } from "./recent-list.js";
import { emit, on } from "./app-events.js";

const { invoke } = window.__TAURI__.core;

let pinnedContainer = null;
let recentContainer = null;

export function initSidebar() {
  pinnedContainer = document.getElementById("sidebar-pinned");
  recentContainer = document.getElementById("sidebar-recent");

  refresh();
  on("file-opened", refresh);
}

async function refresh() {
  const entries = await invoke("get_recent_files");
  const { pinned, recent } = groupByPinned(entries);
  render(pinnedContainer, pinned);
  render(recentContainer, recent);
}

function render(container, entries) {
  container.innerHTML = "";
  for (const entry of entries) {
    container.appendChild(renderRow(entry));
  }
}

function renderRow(entry) {
  const row = document.createElement("div");
  row.className = "sidebar-row";

  const label = document.createElement("span");
  label.className = "sidebar-row-label";
  label.textContent = entry.name;
  label.title = entry.path;
  label.addEventListener("click", () => {
    emit("open-requested", { path: entry.path });
  });
  row.appendChild(label);

  const pinBtn = document.createElement("button");
  pinBtn.className = "sidebar-pin-btn";
  pinBtn.textContent = entry.pinned ? "★" : "☆"; // filled/outline star
  pinBtn.title = entry.pinned ? "Unpin" : "Pin";
  pinBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    await invoke("toggle_pin", { path: entry.path });
    await refresh();
  });
  row.appendChild(pinBtn);

  return row;
}
