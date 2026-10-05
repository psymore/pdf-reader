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

export function resolveDualPageMode(viewportWidth, pageCount, preference = null) {
  if (pageCount <= 1 || preference === "single") return false;
  if (preference === "dual") return true;
  return viewportWidth > 1200;
}

// Zoom at which a whole page is visible at once: the smaller of the
// width-fit (computeFitZoom) and the height-fit, so neither dimension
// overflows the viewport. Used by the "fit page" control and as the
// minimum zoom in paged scroll mode.
export function computeFitPageZoom(
  availableWidth,
  availableHeight,
  pageWidth,
  pageHeight,
  gap,
  dualPageMode,
) {
  const widthFit = computeFitZoom(availableWidth, pageWidth, gap, dualPageMode);
  if (availableHeight <= 0 || pageHeight <= 0) return widthFit;
  const heightFit = availableHeight / pageHeight;
  return Math.min(widthFit, heightFit);
}

// Which page is "current" given each laid-out page's on-screen vertical
// span and a reference line (usually the viewport's top edge). A page that
// straddles the line wins; otherwise the page whose centre is nearest it.
// `positions` is [{ pageNumber, top, bottom }] in viewport coordinates.
export function currentPageFromPositions(positions, referenceY) {
  if (!positions || positions.length === 0) return null;
  let best = positions[0].pageNumber;
  let bestDistance = Infinity;
  for (const position of positions) {
    if (referenceY >= position.top && referenceY < position.bottom) {
      return position.pageNumber;
    }
    const center = (position.top + position.bottom) / 2;
    const distance = Math.abs(center - referenceY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = position.pageNumber;
    }
  }
  return best;
}
