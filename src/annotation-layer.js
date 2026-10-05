// src/annotation-layer.js
import { clientToPage, simplifyPath, hitTestMark, NOTE_ICON_SIZE } from "./page-geometry.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const INK_WIDTH = 2.5;

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function pathData(points) {
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
  // A lone point needs a zero-length segment so the round cap draws a dot.
  return points.length === 1 ? `${d} L${points[0].x} ${points[0].y}` : d;
}

function renderMark(mark) {
  if (mark.type === "highlight") {
    const g = svgEl("g", { fill: mark.color, "fill-opacity": 0.4, "data-mark": mark.id });
    g.style.mixBlendMode = "multiply";
    for (const r of mark.rects) g.append(svgEl("rect", { x: r.x, y: r.y, width: r.w, height: r.h }));
    return g;
  }
  if (mark.type === "ink") {
    return svgEl("path", {
      d: pathData(mark.points), fill: "none", stroke: mark.color, "stroke-width": mark.width,
      "stroke-linecap": "round", "stroke-linejoin": "round", "data-mark": mark.id,
    });
  }
  if (mark.type === "note") {
    const g = svgEl("g", { "data-mark": mark.id });
    g.append(
      svgEl("rect", { x: mark.x, y: mark.y, width: NOTE_ICON_SIZE, height: NOTE_ICON_SIZE, rx: 4, fill: mark.color }),
      svgEl("path", { d: `M${mark.x + 6} ${mark.y + 9}h12M${mark.x + 6} ${mark.y + 14}h8`, stroke: "#fff", "stroke-width": 2, "stroke-linecap": "round" })
    );
    const title = svgEl("title");
    title.textContent = mark.text;
    g.append(title);
    return g;
  }
  return null;
}

export function createAnnotationLayerController({ store, onStatus = () => {} }) {
  const pagesInfo = new Map(); // pageNumber -> { width, height, slot, svg, surface, preview }
  let tool = null;
  let color = "#ffeb3b";

  // The viewer does not always call the unload hook (bulk discards), so an
  // entry may point at a detached slot. Drop such entries when we notice.
  function liveInfo(pageNumber) {
    const info = pagesInfo.get(pageNumber);
    if (!info) return null;
    if (!info.slot.isConnected) {
      pagesInfo.delete(pageNumber);
      return null;
    }
    return info;
  }

  function drawPage(pageNumber) {
    const info = liveInfo(pageNumber);
    if (!info) return;
    info.svg.replaceChildren(...store.marksOnPage(pageNumber).map(renderMark).filter(Boolean));
    if (info.preview) info.svg.append(info.preview);
  }

  const unsubscribe = store.subscribe(({ pages }) => {
    for (const p of pages) drawPage(p);
  });

  function toPage(info, event) {
    return clientToPage(event.clientX, event.clientY, info.svg.getBoundingClientRect(), info.width, info.height);
  }

  function attachInput(info, pageNumber) {
    const { surface } = info;
    const active = new Set(); // pointer ids currently down on this surface
    let poisoned = false; // multi-touch seen: no mark until every pointer is released
    let stroke = null; // { points }
    let notePoint = null; // note tool: placed on release, not on press
    let moveHandler = null; // set by tool-specific logic (Task 6 adds highlight)

    const cancel = () => {
      stroke = null;
      notePoint = null;
      moveHandler = null;
      if (info.preview) { info.preview.remove(); info.preview = null; }
    };

    surface.addEventListener("pointerdown", (event) => {
      // Only the primary button marks; the middle button is autoscroll.
      if (!tool || event.button !== 0) return;
      active.add(event.pointerId);
      // A second finger means pinch-zoom: abandon the mark in progress.
      if (active.size > 1) { poisoned = true; cancel(); return; }
      poisoned = false;
      event.preventDefault();
      const point = toPage(info, event);

      if (tool === "ink") {
        stroke = { points: [point] };
        info.preview = svgEl("path", { fill: "none", stroke: color, "stroke-width": INK_WIDTH, "stroke-linecap": "round", "stroke-linejoin": "round" });
        info.svg.append(info.preview);
        surface.setPointerCapture?.(event.pointerId);
      } else if (tool === "note") {
        // Opening the textarea on press would lose focus to the press's own
        // default action (and fire on the first finger of a pinch).
        notePoint = point;
      } else if (tool === "eraser") {
        eraseAt(pageNumber, point);
        stroke = { points: [point] };
        surface.setPointerCapture?.(event.pointerId);
      } else if (tool === "highlight") {
        info.beginHighlight?.(event, point, (fn) => { moveHandler = fn; });
      }
    });

    surface.addEventListener("pointermove", (event) => {
      if (!tool || poisoned || !active.has(event.pointerId)) return;
      const point = toPage(info, event);
      if (tool === "ink" && stroke) {
        stroke.points.push(point);
        info.preview.setAttribute("d", pathData(stroke.points));
      } else if (tool === "eraser" && stroke) {
        eraseAt(pageNumber, point);
      } else if (moveHandler) {
        moveHandler(event, point);
      }
    });

    const end = (event, commit) => {
      if (!active.delete(event.pointerId)) return;
      const ok = commit && !poisoned;
      if (active.size === 0) {
        if (ok && tool === "ink" && stroke) {
          const points = simplifyPath(stroke.points);
          store.add({ type: "ink", page: pageNumber, color, width: INK_WIDTH, points });
        } else if (ok && tool === "note" && notePoint) {
          placeNote(info, pageNumber, notePoint);
        } else if (ok && moveHandler) {
          info.endHighlight?.();
        }
        poisoned = false;
      }
      cancel();
    };
    surface.addEventListener("pointerup", (event) => end(event, true));
    surface.addEventListener("pointercancel", (event) => end(event, false));
  }

  function eraseAt(pageNumber, point) {
    const hit = [...store.marksOnPage(pageNumber)].reverse().find((m) => hitTestMark(m, point.x, point.y));
    if (hit) store.remove(hit.id);
  }

  function placeNote(info, pageNumber, point) {
    const input = document.createElement("textarea");
    input.className = "annot-note-input";
    input.placeholder = "Note";
    input.rows = 2;
    // The slot is the positioning context and the svg fills it, so percent of
    // page units equals percent of the slot at any zoom.
    input.style.left = `${(point.x / info.width) * 100}%`;
    input.style.top = `${(point.y / info.height) * 100}%`;
    info.slot.append(input);
    input.focus();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      input.remove();
      if (save && text) store.add({ type: "note", page: pageNumber, color, x: point.x, y: point.y, text });
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") finish(false);
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish(true);
    });
  }

  function syncSurfaces() {
    for (const n of [...pagesInfo.keys()]) {
      const info = liveInfo(n);
      if (!info) continue;
      info.surface.style.pointerEvents = tool ? "auto" : "none";
      info.surface.dataset.tool = tool ?? "";
    }
  }

  const controller = {
    handlePageRendered({ pageNumber, width, height, slot, viewport, pageProxy, renderedZoom }) {
      const svg = svgEl("svg", { class: "annot-svg", viewBox: `0 0 ${width} ${height}` });
      const surface = document.createElement("div");
      surface.className = "annot-surface";
      slot.append(svg, surface);
      const info = { width, height, slot, svg, surface, preview: null, viewport, pageProxy, renderedZoom };
      pagesInfo.set(pageNumber, info);
      attachInput(info, pageNumber);
      drawPage(pageNumber);
      syncSurfaces();
      controller.onPageReady?.(info, pageNumber); // Task 6 hook: text layer
    },
    handlePageUnloaded(pageNumber) {
      pagesInfo.delete(pageNumber);
    },
    setTool(next) {
      tool = next;
      syncSurfaces();
      controller.onToolChanged?.(next); // Task 6 hook
    },
    getTool: () => tool,
    setColor(hex) { color = hex; },
    getColor: () => color,
    redrawAll() { for (const n of [...pagesInfo.keys()]) drawPage(n); },
    pageInfo: (n) => pagesInfo.get(n),
    pagesInfo,
    dispose() { unsubscribe(); pagesInfo.clear(); },
  };
  return controller;
}
