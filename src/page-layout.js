export function computePageColumns(availableWidth, pageWidth, gap, dualPageMode, pageCount = Infinity) {
  if (!dualPageMode) return 1;
  if (availableWidth <= 0 || pageWidth <= 0) return Math.min(pageCount, 2);
  const fittingColumns = Math.max(2, Math.floor((availableWidth + gap) / (pageWidth + gap)));
  return Math.min(pageCount, fittingColumns);
}

export function computeFitZoom(availableWidth, pageWidth, gap, dualPageMode) {
  if (availableWidth <= 0 || pageWidth <= 0) return 1;
  const columns = dualPageMode ? 2 : 1;
  return (availableWidth - gap * (columns - 1)) / (pageWidth * columns);
}
