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

  initDrawer();
}

function initDrawer() {
  const appShell = document.getElementById("app-shell");
  const toggleBtn = document.getElementById("sidebar-toggle-btn");
  const backdrop = document.getElementById("sidebar-backdrop");

  // true while a close is being driven by a popstate (i.e. the Android back
  // button/gesture), so setOpen doesn't also try to pop a history entry
  // that's already in the middle of being consumed by that navigation.
  let closingViaHistory = false;

  const setOpen = (open) => {
    const wasOpen = appShell.classList.contains("sidebar-open");
    if (open === wasOpen) return;
    appShell.classList.toggle("sidebar-open", open);
    toggleBtn.setAttribute("aria-expanded", String(open));

    // Tauri's Android shell maps the hardware/gesture back button to
    // WebView.goBack(), which only fires if there's same-document history to
    // go back to. Pushing an entry while the drawer is open means back
    // closes the drawer first instead of leaving/exiting the app; closing it
    // any other way pops that entry again so the history stack stays clean.
    if (open) {
      history.pushState({ sidebarOpen: true }, "");
    } else if (!closingViaHistory && history.state?.sidebarOpen) {
      history.back();
    }
  };

  window.addEventListener("popstate", () => {
    if (appShell.classList.contains("sidebar-open")) {
      closingViaHistory = true;
      setOpen(false);
      closingViaHistory = false;
    }
  });

  toggleBtn.addEventListener("click", () => {
    setOpen(!appShell.classList.contains("sidebar-open"));
  });
  backdrop.addEventListener("click", () => setOpen(false));
  // picking a file should get the drawer out of the way on narrow screens
  on("open-requested", () => setOpen(false));

  initSwipeToClose(document.getElementById("sidebar"), setOpen);
}

// Lets a touch user drag the open drawer closed instead of only tapping the
// backdrop or toggle button. Tracks the raw finger position during the drag
// so the drawer follows the finger, then either commits to closed or snaps
// back based on how far/fast the swipe went. A real-world swipe is usually
// a quick, short flick rather than a slow drag past a distance threshold,
// so a fast flick commits to closed even if it didn't travel very far.
function initSwipeToClose(sidebar, setOpen) {
  const CLOSE_DISTANCE_RATIO = 0.3; // fraction of drawer width that counts as "closed" on its own
  const FLICK_VELOCITY = 0.5; // px/ms leftward that counts as a deliberate flick
  const FLICK_MIN_DISTANCE = 24; // ignore tiny jitters when checking velocity
  let startX = null;
  let startTime = 0;
  let currentDeltaX = 0;
  let lastMoveX = 0;
  let lastMoveTime = 0;
  let velocity = 0; // px/ms, negative = leftward
  let dragging = false;

  sidebar.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startTime = event.timeStamp;
      lastMoveX = startX;
      lastMoveTime = startTime;
      currentDeltaX = 0;
      velocity = 0;
      dragging = true;
      sidebar.style.transition = "none";
    },
    { passive: true }
  );

  sidebar.addEventListener(
    "touchmove",
    (event) => {
      if (!dragging || startX === null) return;
      const touchX = event.touches[0].clientX;
      const dt = event.timeStamp - lastMoveTime;
      if (dt > 0) velocity = (touchX - lastMoveX) / dt;
      lastMoveX = touchX;
      lastMoveTime = event.timeStamp;

      currentDeltaX = Math.min(0, touchX - startX); // only allow dragging leftward (closing)
      sidebar.style.transform = `translateX(${currentDeltaX}px)`;
    },
    { passive: true }
  );

  const endSwipe = () => {
    if (!dragging) return;
    dragging = false;
    sidebar.style.transition = "";
    sidebar.style.transform = "";
    const closeDistance = -sidebar.getBoundingClientRect().width * CLOSE_DISTANCE_RATIO;
    const wasFlicked = currentDeltaX < -FLICK_MIN_DISTANCE && velocity < -FLICK_VELOCITY;
    if (currentDeltaX < closeDistance || wasFlicked) {
      setOpen(false);
    }
    startX = null;
    currentDeltaX = 0;
  };

  sidebar.addEventListener("touchend", endSwipe);
  sidebar.addEventListener("touchcancel", endSwipe);
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
