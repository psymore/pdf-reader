// Pure annotation model. Coordinates are page units: the viewer's scale-1
// viewport, origin top-left, y down. No DOM access here.

export function createAnnotationStore() {
  let marks = [];
  let undoStack = []; // { kind: "add" | "remove", mark, index }
  let redoStack = [];
  let nextId = 1;
  let cleanDepth = 0; // undoStack.length when last saved; -1 = unreachable
  const listeners = new Set();

  function notify(pages) {
    for (const fn of listeners) fn({ pages: new Set(pages) });
  }

  function insertAt(mark, index) {
    marks.splice(Math.min(index, marks.length), 0, mark);
  }

  function apply(entry, reverse) {
    const adding = (entry.kind === "add") !== reverse;
    if (adding) {
      insertAt(entry.mark, entry.index);
    } else {
      marks = marks.filter((m) => m.id !== entry.mark.id);
    }
  }

  return {
    add(mark) {
      const stored = { ...mark, id: `m${nextId++}` };
      marks.push(stored);
      undoStack.push({ kind: "add", mark: stored, index: marks.length - 1 });
      redoStack = [];
      if (cleanDepth > undoStack.length - 1) cleanDepth = -1;
      notify([stored.page]);
      return stored;
    },
    remove(id) {
      const index = marks.findIndex((m) => m.id === id);
      if (index < 0) return false;
      const mark = marks[index];
      marks.splice(index, 1);
      undoStack.push({ kind: "remove", mark, index });
      redoStack = [];
      if (cleanDepth > undoStack.length - 1) cleanDepth = -1;
      notify([mark.page]);
      return true;
    },
    undo() {
      const entry = undoStack.pop();
      if (!entry) return false;
      apply(entry, true);
      redoStack.push(entry);
      notify([entry.mark.page]);
      return true;
    },
    redo() {
      const entry = redoStack.pop();
      if (!entry) return false;
      apply(entry, false);
      undoStack.push(entry);
      notify([entry.mark.page]);
      return true;
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    isDirty: () => undoStack.length !== cleanDepth,
    markSaved() {
      cleanDepth = undoStack.length;
    },
    clear() {
      const pages = marks.map((m) => m.page);
      marks = [];
      undoStack = [];
      redoStack = [];
      cleanDepth = 0;
      notify(pages);
    },
    marksOnPage: (page) => marks.filter((m) => m.page === page),
    all: () => [...marks],
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
