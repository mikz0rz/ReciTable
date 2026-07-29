// Rendering for the run log the background worker writes to session storage.
//
// Kept separate from the viewer so the run sheet is described in one place,
// independent of whatever is showing it.

export const GLYPH = { run: "·", ok: "✓", warn: "!", error: "×" };

export const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

export function elapsed(run) {
  return (run.endedAt || Date.now()) - run.startedAt;
}

export function activeStep(run) {
  return run.steps.find((step) => step.state === "run") || null;
}

/** Fill `list` (a <ul>/<ol>) with one row per step. */
export function renderRunLog(list, run) {
  list.replaceChildren();
  for (const step of run.steps) {
    const row = document.createElement("li");
    row.dataset.state = step.state;

    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.textContent = GLYPH[step.state] || "·";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = step.label;

    const time = document.createElement("span");
    time.className = "ms";
    // A running step's clock keeps moving; a settled one is fixed.
    time.textContent = secs(step.state === "run" ? Date.now() - step.startedAt : step.ms);

    row.append(glyph, label, time);
    if (step.detail) {
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = step.detail;
      row.append(detail);
    }
    list.append(row);
  }
}

/** One line describing where the run got to, for a title bar or a summary. */
export function runHeadline(run) {
  if (run.state === "running") {
    const step = activeStep(run);
    return step ? `${step.label}…` : "Working…";
  }
  if (run.state === "done") return `Done in ${secs(elapsed(run))}`;
  if (run.state === "cancelled") return "Cancelled";
  return run.error?.message || "Something went wrong";
}

/** The extra context worth showing under a failure. */
export function errorDetail(run) {
  const bits = [];
  if (run.error?.status) bits.push(`HTTP ${run.error.status}`);
  if (run.error?.needsSetup) bits.push("open settings to finish setup");
  if (run.error?.detail) bits.push(run.error.detail);
  bits.push("Full trace: chrome://extensions → Inspect views: service worker");
  return bits.join(" · ");
}

/** Everything needed to describe a failure, and no API key. */
export function diagnostics(run) {
  return JSON.stringify(
    {
      provider: run?.provider,
      model: run?.model,
      url: run?.url,
      state: run?.state,
      error: run?.error,
      steps: run?.steps?.map((s) => ({
        label: s.label,
        detail: s.detail,
        ms: s.ms,
        state: s.state,
      })),
      userAgent: navigator.userAgent,
    },
    null,
    2,
  );
}
