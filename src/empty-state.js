import { emit } from "./app-events.js";

export function initEmptyState() {
  const zone = document.getElementById("empty-state");
  zone.addEventListener("click", () => {
    emit("dialog-open-requested");
  });
}
