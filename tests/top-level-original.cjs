// Reference behavior from main at 0d5e2c523061e9a59ef8f042f722e60784e0885e.
// Keep unchanged so optimized implementations can be checked against it.
function topLevel(runs) {
  const wfs = runs.filter((r) => r.kind === "workflow");
  return runs.filter((r) => {
    if (r.kind !== "method") return true;
    const t = Date.parse(r.startedAt);
    return !wfs.some((w) => {
      if (w.repo !== r.repo) return false;
      const start = Date.parse(w.startedAt) - 2000;
      const open = w.status === "running" || w.status === "suspended" || w.ms == null;
      return t >= start && (open || t <= Date.parse(w.startedAt) + w.ms + 2000);
    });
  });
}

module.exports = topLevel;
