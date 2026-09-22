export function groupByPinned(entries) {
  const pinned = entries
    .filter((e) => e.pinned)
    .slice()
    .sort((a, b) => b.opened_at - a.opened_at);
  const recent = entries
    .filter((e) => !e.pinned)
    .slice()
    .sort((a, b) => b.opened_at - a.opened_at);
  return { pinned, recent };
}
